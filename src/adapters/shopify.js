const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { stealthGet, isRateLimited } = require('../utils/stealth-http');
const { markProxyBlocked, markProxySuccess } = require('../core/proxy');

// Shopify prices by the CALLER'S GEOGRAPHY. The app runs from Railway in Virginia, so these
// Canadian stores were quoting USD while we labelled the result CAD — measured on live stores:
//   zardocards    US 602.00  vs  CA 800.00   (-25%)
//   hobbiesville  US 600.00  vs  CA 829.95   (-28%)
//   kanzengames   US 117.90  vs  CA 159.95   (-26%)
// Every Shopify alert was understating the price by about a quarter. This cookie pins the
// storefront to Canada, verified from a US IP to return prices identical to a Canadian one.
// It is free — the alternative was routing every catalogue fetch through a Canadian proxy.
const CA_LOCALE_HEADERS = {
  'Cookie': 'localization=CA; cart_currency=CAD',
  'Accept-Language': 'en-CA,en;q=0.9',
};
const { normalizePrice } = require('../utils/helpers');

// How often a shop reads its WHOLE catalogue rather than just the newest page. New listings
// are caught on every poll regardless; this cadence only bounds how quickly a stock or price
// change deep in the catalogue is noticed.
// Back to 5 minutes. This was raised to 15 when sweeps were competing with fast polls for a
// single overloaded budget, but that contention is gone: shops now run on 8 ISP exits with a
// per-IP budget, and sweeps yield to fast polls in the queue.
//
// The cadence is the ceiling on how STALE a product deep in a catalogue can be, and staleness
// is what produced the alert floods — every change accumulated over the window fired the
// instant the sweep landed. Measured load at 5 minutes: 1.55 req/s total, ~0.35 req/s on the
// busiest exit against a 2.5 ceiling. There is no reason to make customers wait 15 minutes
// for a restock alert to buy headroom we are not using.
const FULL_SWEEP_MS = 5 * 60 * 1000;

const rateBudget = require('../utils/rate-budget');
const SHOPIFY_BUDGET = 'shopify';

// What one exit IP may spend. 2.5 req/sec is the rate measured as safe on the direct Railway
// IP, so it is the honest per-IP figure to assume for a proxy too until measured otherwise.
// The win is not a higher per-IP rate — it is having ten of them instead of one.
const PER_IP_BUDGET = { ratePerSec: 2.5, burst: 5 };

function hostOfProxy(proxyUrl) {
  try { return new URL(proxyUrl).hostname; } catch { return proxyUrl; }
}

/**
 * How many products a FAST poll asks for.
 *
 * This was 50, on the reasoning that new listings sit at the top of page 1 so a small slice
 * is enough. That is true for NEW LISTINGS and false for everything else, and the gap caused
 * real alert floods.
 *
 * Measured against the three collection shops:
 *
 *   shop            fast poll @50    full sweep     never seen between sweeps
 *   facetoface         131 SKUs      1,581 SKUs        1,450  (92%)
 *   chimeragaming       54 SKUs        184 SKUs          130  (71%)
 *   untouchables       344 SKUs      7,923 SKUs        7,579  (96%)
 *
 * A restock can happen anywhere in a catalogue, not just at the top. So 92% of facetoface was
 * only being checked every 15 minutes, and every stock change in that window fired at once
 * when the sweep landed — 13 alerts in 0s, tripping the flood suppressor. The alerts were
 * genuine; they were just late and clumped, which is its own kind of wrong.
 *
 * 250 is Shopify's maximum page size and costs the SAME ONE REQUEST, only more bytes
 * (measured 95-335KB vs 60-100KB). Payload was never the latency bottleneck here — queue
 * order was, and that is fixed in rate-budget.js — so buying 5x the coverage for zero extra
 * requests is the right trade.
 */
const FAST_PAGE_LIMIT = 250;

/**
 * Non-TCG filter, shared by every shop.
 *
 * 25 of the 31 shops have no keyword list and no collections, so they tracked their entire
 * catalogue — tcgfy was surfacing "Women's Feather Fur Peep Toe Mules" as a monitored product.
 *
 * The obvious fix, an include-list of TCG keywords, was tested against live data and is WRONG.
 * Card titles mostly do not contain the game's name: they use character and set names. The
 * existing 19-keyword list dropped 85 real Pokemon cards from zardocards alone — "Rayquaza
 * Vmax 102/159 Crown Zenith", "Eevee ex - SV Scarlet & Violet Promo", "PSA 10 PICHU". Chasing
 * every character and set name is unwinnable, and every gap is a MISSED DROP, which is the one
 * failure this product exists to prevent. Junk getting through is merely annoying.
 *
 * So this excludes instead: only things positively identified as not-cards. Measured across
 * page 1 of all 25 shops — 6,123 products, 195 removed (3.2%), all of them genuinely shampoo,
 * shoes, Funko Pops, Warhammer, board games or console games, and not one card.
 *
 * RESCUE always wins over a block, so anything that smells like a card survives even if its
 * category looks wrong — a sealed Pokemon box filed under "Toys & Games" stays.
 */
const NON_TCG_TYPE = [
  'shoe', 'sandal', 'heel', 'bag', 'backpack', 'shampoo', 'conditioner', 'skincare',
  'apparel', 'clothing', 'sweater', 'hoodie', 't-shirt', 'jewelry', 'comic', 'manga',
  'video game', 'playstation', 'xbox', 'nintendo switch', 'board game', 'miniature',
  'warhammer', 'paint', 'model kit', 'funko', 'plush', 'candle', 'mug',
];
const NON_TCG_TITLE = ['women’s', "women's", 'shampoo', 'peep toe', 'high heel'];
const TCG_RESCUE = [
  'pokemon', 'pokémon', 'tcg', 'trading card', 'booster', 'elite trainer', 'one piece',
  'yugioh', 'yu-gi-oh', 'lorcana', 'digimon', 'magic the gathering', 'mtg', 'flesh and blood',
  'grand archive', 'star wars: unlimited', 'union arena', 'weiss schwarz', 'vanguard',
  'single', 'slab', 'psa ', 'cgc ', 'graded',
];

function isNonTcg(item) {
  const type = String(item.product_type || '').toLowerCase();
  const title = String(item.title || '').toLowerCase();
  const tags = (item.tags || []).join(' ').toLowerCase();
  const hay = `${type} ${title} ${tags}`;
  // A false negative costs a missed drop; a false positive costs one junk alert. Rescue first.
  if (TCG_RESCUE.some(k => hay.includes(k))) return false;
  if (NON_TCG_TYPE.some(k => type.includes(k))) return true;
  return NON_TCG_TITLE.some(k => title.includes(k));
}

/**
 * Universal Shopify adapter — works for ANY Shopify store.
 * Shopify exposes /products.json and /collections/{handle}.json publicly.
 * One adapter instance per store, configured via retailers.json.
 */
class ShopifyAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    // Shopify-specific config from retailers.json
    this.collections = config.collections || []; // e.g. ['pokemon', 'trading-cards', 'new-arrivals']
    this.searchKeywords = config.searchKeywords || [];
    this.pageLimit = config.pageLimit || 250; // Shopify max per page
    // Conditional-request state, keyed by page URL. Both survive across polls: the ETag is what
    // earns the 304, and the cached page is what lets us skip parsing when we get one.
    this._etags = new Map();
    this._pageCache = new Map();
  }

  /**
   * Is this poll a cheap "what's new" check, or a full catalogue sweep?
   *
   * These shops carry 11,000-19,000 products, so a full sweep is ten paged requests. Doing
   * that every 8 seconds was ~1.25 req/sec against a SINGLE store and ~39 req/sec in
   * aggregate, which is what got every shop rate-limited and then circuit-broken.
   *
   * It was also unnecessary. Measured against four live shops, /products.json is ordered by
   * published_at DESCENDING (401games: 15:22, 15:20, 15:19, 15:16, 15:09 ... strictly
   * ordered, while created_at is not). Every newly published product therefore appears on
   * page 1. We were fetching ten pages to find listings that were always in the first one.
   *
   * So: page 1 on every poll for new-listing speed, a full sweep on a slow cadence for
   * stock and price accuracy across the whole catalogue. Sweeps are offset per shop so all
   * 31 do not sweep on the same tick.
   */
  _isFullSweepDue(now = Date.now()) {
    if (this._lastFullSweep === undefined) {
      // Deterministic per-shop offset from the id, so sweeps spread across the window
      // instead of clustering — same reasoning as the scheduler's phase spread.
      let h = 0;
      for (const ch of String(this.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      this._sweepOffset = h % FULL_SWEEP_MS;

      // Do NOT sweep on the first poll. Every shop booting into a full sweep meant 31 shops
      // x 10 pages = ~310 requests inside the first few seconds of every deploy — the exact
      // ~39 req/sec burst that caused the original outage, re-created on each restart. It
      // showed up as shops taking 429s immediately at startup and going straight back into
      // cooldown.
      //
      // Instead, back-date the clock so this shop's first sweep falls at boot + its own
      // offset, spreading the 31 initial sweeps across the whole 5-minute window (~10s
      // apart). Polls before then are fast ones, which still catch every new listing.
      this._lastFullSweep = now - FULL_SWEEP_MS + this._sweepOffset;
    }
    return now - this._lastFullSweep >= FULL_SWEEP_MS;
  }

  async fetchProducts() {
    const products = {};
    // Reset per poll. If every page comes back 304 we can tell the scheduler that nothing
    // moved, and it can skip the diff and the Redis round-trips entirely.
    this._anyPageChanged = false;

    // A fast poll reads only the newest page, so it is a PARTIAL view of the catalogue.
    // Say so explicitly rather than leaving the poll layer to infer it from counts — the
    // existing heuristic (new < 30% of cached) is right for a 19,000-product shop but would
    // wrongly conclude "complete" for a 300-product one and mark real stock out of stock.
    const fullSweep = this._isFullSweepDue();
    this._partialPoll = !fullSweep;

    if (!fullSweep) {
      try {
        // Read page 1 the same way this shop is normally read, so the fast path never widens
        // or narrows what the shop tracks. A collection-configured shop is pre-filtered by
        // the retailer and deliberately does NOT apply the keyword filter; a catalogue-wide
        // shop does. Getting this wrong would let Magic singles through on a Pokemon monitor.
        if (this.collections.length > 0) {
          // In parallel, not in series. These shops pay one request per collection, and
          // fetching them one after another put Untouchables at 10.2s and Chimera Gaming at
          // 10.3s while every single-request shop sat comfortably under 9.6s — the only two
          // shops missing the target, purely because their requests were queued end to end.
          // The budget still paces them; this only stops the second waiting on the first.
          const pages = await Promise.all(this.collections.map(handle => this._fetchPage(
            `${this.url}/collections/${handle}/products.json?limit=${FAST_PAGE_LIMIT}&page=1`,
          )));
          // Parse after the fetches so ordering stays deterministic regardless of which
          // collection returns first.
          for (const { products: page } of pages) {
            this._detectPriceUnit(page);
            for (const item of page) this.parseShopifyProduct(item, products);
          }
        } else {
          const { products: page } = await this._fetchPage(
            `${this.url}/products.json?limit=${FAST_PAGE_LIMIT}&page=1`,
          );
          this._detectPriceUnit(page);
          for (const item of page) {
            if (this.searchKeywords.length > 0) {
              const text = `${item.title} ${item.product_type} ${item.tags?.join(' ')}`.toLowerCase();
              if (!this.searchKeywords.some(kw => text.includes(kw.toLowerCase()))) continue;
            }
            this.parseShopifyProduct(item, products);
          }
        }
        return products;
      } catch (err) {
        if (isRateLimited(err)) throw err; // a throttled poll is a failed poll, not an empty one
        logger.warn(`${this.name}: fast poll failed, falling back to full sweep: ${err.message}`);
        this._partialPoll = false;
      }
    }

    this._lastFullSweep = Date.now();

    // A throttled shop and an empty shop used to look identical from here: both returned {}.
    // That is what let a burst of 429s raise "PARSER SUSPECT — 0% of products have a price"
    // and, on recovery, an alert flood. Track WHY we came back empty.
    let throttled = false;

    // Any collection that fails leaves the catalogue INCOMPLETE, which matters more than it
    // looks. A shop with two collections that loses one still returns plenty of products, so
    // the empty-result guard below does not fire and the count heuristic in poll-adapter
    // ("new < 30% of old") reads 81-of-131 as a complete read. Stale cleanup then marks the
    // missing collection's ~50 products OUT OF STOCK, and the next successful sweep reports
    // them all coming back — a burst of false RESTOCK alerts. That is what tripped the flood
    // suppressor on facetoface: 13 alerts in 0s for products that never went out of stock.
    let incomplete = false;

    // Method 1: Fetch from specific collections
    for (const collection of this.collections) {
      try {
        await this.fetchCollection(collection, products);
      } catch (err) {
        if (isRateLimited(err)) throttled = true;
        incomplete = true;
        logger.warn(`${this.name}: collection "${collection}" failed: ${err.message}`);
      }
    }

    // Method 2: Fetch all products (fallback if no collections configured OR collections returned nothing)
    if (this.collections.length === 0 || Object.keys(products).length === 0) {
      try {
        await this.fetchAllProducts(products);
      } catch (err) {
        if (isRateLimited(err)) throttled = true;
        incomplete = true;
        logger.warn(`${this.name}: /products.json failed: ${err.message}`);
      }
    }

    // Empty because the retailer refused us is a failed poll, not a catalogue of nothing.
    // Throwing keeps it out of the diff, the health ratio and the event stream alike.
    if (throttled && Object.keys(products).length === 0) {
      throw new Error(`${this.name}: rate limited — skipping poll rather than reporting an empty catalogue`);
    }

    // Partly-read sweep. Declaring it partial makes poll-adapter overlay what we DID read on
    // the cached catalogue instead of treating the gap as products that disappeared, which is
    // the difference between a quiet poll and a burst of false restocks.
    if (incomplete) {
      this._partialPoll = true;
      logger.warn(`${this.name}: sweep incomplete — treating as partial so stale cleanup is skipped`);
    }

    return products;
  }

  /**
   * Fetch one catalogue page, but only pay for it when it has actually changed.
   *
   * Shopify serves an ETag on products.json and honours If-None-Match. These shops were
   * pulling up to ten pages of up to 2MB on EVERY poll — hobbiesville alone is ~20MB a cycle —
   * which is what let 31 shops starve the big six once autotune sped them all up. A 304 costs
   * ~150ms and zero bytes, so an unchanged shop is now nearly free to check.
   *
   * @returns {{products: array, changed: boolean}}
   */
  async _fetchPage(url) {
    // Every Shopify request in the process passes through one shared budget. Per-store
    // cadence has repeatedly looked fine while the aggregate did not — that is what
    // rate-limited all 31 shops into a circuit-broken outage — and this is the only place
    // that sees the total.
    // Route through this shop's assigned ISP proxy when it has one. Shopify rate-limits the
    // CALLER, so 31 shops behind a single Railway IP all compete for one allowance — which is
    // what caused every outage. Behind ten ISP IPs they compete in groups of ~3 instead.
    const { url: proxyUrl, proxyObj } = this.proxyTier === 'isp'
      ? this.getProxy()
      : { url: null, proxyObj: null };

    // Budget keyed by EXIT IP, not globally. A shop behind proxy A is not spending proxy B's
    // allowance, and one shared bucket would throttle them as if it were.
    const budgetKey = proxyUrl ? `shopify:${hostOfProxy(proxyUrl)}` : SHOPIFY_BUDGET;

    // A fast poll is the thing detection latency is measured on; a sweep is background work
    // that can wait. Without this the sweep's ten back-to-back requests sat in front of every
    // new-listing check and cost ~2-3s per poll.
    const priority = this._partialPoll ? 0 : 1;
    const granted = await rateBudget.acquire(budgetKey, 8000, priority, PER_IP_BUDGET);
    if (!granted) {
      // Out of budget rather than blocked. Report it as throttling so the poll is skipped
      // cleanly instead of counting as an error and tripping the circuit breaker.
      throw new Error(`Rate limited (budget): ${url}`);
    }

    const etag = this._etags.get(url);
    let res;
    try {
      res = await stealthGet(url, {
        proxyUrl,
        // One connection per shop, so two shops sharing an exit IP do not share a socket.
        lane: proxyUrl ? this.id : null,
        withResponse: true,
        rawHeaders: true,
        timeoutMs: 15000,
        maxRetries: 1,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate, br',
          ...CA_LOCALE_HEADERS,
          ...(etag ? { 'If-None-Match': etag } : {}),
        },
      });
    } catch (err) {
      // Tell the pool when a proxy is the problem, so it can be rotated out rather than
      // handed to the next shop that asks. A 429 is the SHOP throttling us, not the proxy
      // failing, so it must not mark the IP unhealthy.
      if (proxyObj && !isRateLimited(err) && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
    if (proxyObj) markProxySuccess(proxyObj);

    if (res.status === 304) {
      // Unchanged — reuse what this page gave us last time, parse nothing, transfer nothing.
      return { products: this._pageCache.get(url) || [], changed: false };
    }
    this._anyPageChanged = true;
    let data;
    try { data = JSON.parse(res.body); } catch { return { products: [], changed: false }; }
    const list = data.products || [];
    if (res.headers.etag) this._etags.set(url, res.headers.etag);
    this._pageCache.set(url, list);
    return { products: list, changed: true };
  }

  async fetchCollection(handle, products) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.url}/collections/${handle}/products.json?limit=${this.pageLimit}&page=${page}`;
      const data = { products: (await this._fetchPage(url)).products };

      if (!data.products || data.products.length === 0) {
        hasMore = false;
        break;
      }

      this._detectPriceUnit(data.products);

      for (const item of data.products) {
        this.parseShopifyProduct(item, products);
      }

      // Shopify returns empty array when no more pages
      hasMore = data.products.length === this.pageLimit;
      page++;

      // Safety: max 10 pages per collection
      if (page > 10) break;
    }
  }

  async fetchAllProducts(products) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.url}/products.json?limit=${this.pageLimit}&page=${page}`;
      const data = { products: (await this._fetchPage(url)).products };

      if (!data.products || data.products.length === 0) {
        hasMore = false;
        break;
      }

      // Judge the store's price unit on the UNFILTERED page — the keyword filter can leave
      // too few prices to read the distribution from.
      this._detectPriceUnit(data.products);

      for (const item of data.products) {
        // Filter by keywords if configured
        if (this.searchKeywords.length > 0) {
          const text = `${item.title} ${item.product_type} ${item.tags?.join(' ')}`.toLowerCase();
          const match = this.searchKeywords.some(kw => text.includes(kw.toLowerCase()));
          if (!match) continue;
        }
        this.parseShopifyProduct(item, products);
      }

      hasMore = data.products.length === this.pageLimit;
      page++;
      if (page > 10) break;
    }
  }

  /**
   * Decide once per poll whether this store quotes cents, from the whole batch rather than
   * one price. Sticky: a confident verdict is kept so a small or unusual page cannot flip it
   * mid-run and rewrite every price by 100x.
   */
  _detectPriceUnit(allProducts) {
    if (this._priceUnitLocked) return;
    const values = [];
    for (const item of allProducts || []) {
      for (const v of item.variants || []) {
        const n = Number(v.price);
        if (!isNaN(n) && n > 0) values.push(n);
      }
    }
    if (values.length < 25) return; // too thin to judge — leave the previous verdict alone
    const roundHundreds = values.filter((n) => n % 100 === 0).length;
    const ratio = roundHundreds / values.length;
    const cents = ratio >= 0.99;
    if (this._pricesAreCents !== cents) {
      logger.info(`${this.name}: prices detected as ${cents ? 'CENTS (dividing by 100)' : 'DOLLARS'} — ${roundHundreds}/${values.length} exact multiples of 100`);
    }
    this._pricesAreCents = cents;
    this._priceUnitLocked = true;
  }

  parseShopifyProduct(item, products) {
    // Applied here rather than at each call site so the fast path, the collection walk and
    // the full sweep all get it — there are four places products enter, and filtering at
    // three of them is how a shop ends up alerting on shoes only on sweep polls.
    if (isNonTcg(item)) return;

    // Each Shopify product can have multiple variants
    for (const variant of item.variants) {
      const inStock = variant.available === true;
      const sku = variant.sku || `${item.id}-${variant.id}`;
      const image = item.images?.[0]?.src || item.image?.src || '';

      let price = typeof variant.price === 'number'
        ? variant.price
        : normalizePrice(variant.price);

      // Some Shopify stores quote prices in cents. Deciding that PER PRICE is wrong in both
      // directions, and the old "divide anything over 5000" rule was measurably wrong on live
      // stores: hobbiesville quotes cents, so its $13.00 deck box (raw "1300.00") was reported
      // as $1,300, while kanzengames quotes dollars, so a genuine $10,000 listing would have
      // been divided down to $100.
      //
      // The unit is a property of the STORE, not of one price, and the distribution says so
      // unambiguously — measured over a full catalogue page:
      //   hobbiesville  696/696  prices are exact multiples of 100  -> cents
      //   zardocards   1192/1192 ->  cents
      //   kanzengames    30/638  ->  dollars
      //   vancitytcg      0/1460 ->  dollars
      // A dollars store always has some price ending in .95/.99; a cents store cannot.
      if (price != null && this._pricesAreCents) {
        price = price / 100;
      }

      const product = this.classify({
        sku,
        name: item.variants.length > 1
          ? `${item.title} - ${variant.title}`
          : item.title,
        price,
        currency: 'CAD',
        url: `${this.url}/products/${item.handle}`,
        image,
        inStock,
        canAddToCart: inStock,
        shipsToHome: true,
      });

      // Add Shopify-specific metadata
      product._variantId = variant.id;
      product._productId = item.id;
      // The moment the shop actually put this listing live. This is the only honest anchor
      // for "how fast did we alert": measuring from our own fetch just reports how long our
      // own request took, which is why the alert footer read ~1s even on a 30s poll cycle.
      product.publishedAt = Date.parse(item.published_at || item.created_at) || null;
      product._tags = item.tags || [];
      product._vendor = item.vendor;
      product.stockCount = variant.inventory_quantity ?? null;

      products[product.sku] = product;
    }
  }

  /**
   * Fast stock check using only cart/add endpoint.
   * Returns true if the variant can be added to cart (in stock).
   * Useful for rapid polling of specific variants without fetching full product data.
   */
  async quickStockCheck(variantId) {
    try {
      const url = `${this.url}/cart/add.js`;
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: variantId, quantity: 1 }),
        json: true,
      });
      return true; // If we get here, it's in stock
    } catch (err) {
      // 422 = variant not available
      return false;
    }
  }
}

module.exports = ShopifyAdapter;
module.exports.FULL_SWEEP_MS = FULL_SWEEP_MS;
module.exports.isNonTcg = isNonTcg;
