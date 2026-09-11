const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { isInScopeName } = require('../utils/scope');
const { stealthGet, isRateLimited, isSelfSkip, cooldownRemaining } = require('../utils/stealth-http');
const { markProxyBlocked, markProxySuccess } = require('../core/proxy');
const state = require('../core/state');

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

// Pages per catalogue sweep. Deliberately the SAME as the old hard ceiling: the window
// rotates to gain coverage, it does not widen to gain it, so the request burst per sweep
// is unchanged and cannot reintroduce the 429s that the old cadence experiment caused.
const SWEEP_PAGES_PER_RUN = 10;
// Floor for the adaptive window. A shop that keeps refusing still makes progress, just
// slowly; dropping to zero would stall the rotation permanently.
const MIN_SWEEP_PAGES = 2;

// How long a page that yielded nothing is trusted to still be empty.
//
// Barren pages were not persisted at all, so every restart made all of them look never-read and
// the 100-page shops (maxProducts 25000 -> 100 pages) spent all ten sweep slots on cold,
// full-payload fetches, forever — never converging on the small productive set that answers 304.
// That burst is what earns the 429s. Remembering them permanently would be the opposite error,
// since a shop grows; a day is long enough to stop the churn and short enough that a page which
// has since filled up is found within one cycle.
const BARREN_RECHECK_MS = Number(process.env.SHOP_BARREN_RECHECK_MS) || 24 * 60 * 60 * 1000;
// And how many of them may be re-checked in a single sweep. Strictly rationed, and taken only
// after the productive pages: ranking stale-barren pages as ordinary discovery put fifty-three
// empty pages ahead of the two that held product on a mapped shop, which is precisely the
// staleness the yield ranking exists to prevent. Two per sweep still walks a 100-page
// catalogue in a few days.
const BARREN_RECHECKS_PER_SWEEP = Number(process.env.SHOP_BARREN_RECHECKS_PER_SWEEP) || 2;

/**
 * Keyword search — the same approach the big seven already use, finally applied to the shops.
 *
 * Walmart, Amazon, Best Buy and Costco do not walk their catalogues; they send the shared
 * query list from config/products.json to each retailer's own search engine. The shops were
 * the odd ones out, paginating up to a hundred pages to find the same products.
 *
 * Measured against the live stores, Shopify's predictive-search endpoint finds 118 in-scope
 * products at hobbiesville from 18 queries where pagination needs 56 page requests for ~130 —
 * 91% of the coverage for a third of the requests, and ~31KB per response instead of ~150KB.
 *
 * The terms come from the SAME shared file the big seven use, so a change there moves every
 * store at once. The list is wider than their four queries only because Shopify hard-caps
 * predictive search at ten results per query however large a limit you ask for, so coverage
 * has to come from more terms rather than deeper pages.
 */
const sharedProducts = require('../config/products.json');
const SEARCH_TERMS = [...new Set([
  ...(sharedProducts.searchQueries || []),
  ...(sharedProducts.setQueries || []),
  ...(sharedProducts.keywords || []),
].map((t) => String(t).trim().toLowerCase()).filter(Boolean))];

// Shopify's own cap. Asking for more is silently ignored — verified against three shops.
const SEARCH_RESULT_LIMIT = 10;
// Search refreshes stock for the in-scope set; the pagination sweep becomes the slower
// backstop that discovers what search misses, which is why it can drop to 45 minutes. The two
// together land within a few percent of the request rate this adapter had before search
// existed, because these shops 429 readily and the budget had to come from somewhere.
//
// ONE term per tick, not the whole list at once. Firing all fourteen together would put a
// fifteen-request burst on a fast poll, which is the shape that produced the 429s in the first
// place — the aggregate rate was never the problem, the clustering was. Spread this way the
// search costs about one extra request every 90 seconds per shop, and the full in-scope set is
// refreshed roughly every 21 minutes.
// One term EVERY poll rather than every 90 seconds. At an 8s poll the fourteen-term list
// cycles in under two minutes, so a product prominent enough to be surfaced by a query is
// re-checked on roughly that cadence instead of every 21 minutes.
//
// It is still one request, so the burst shape that caused the 429s is unchanged — only how
// often that single request is made. If a shop objects, the adaptive backoff narrows the sweep
// and the throttle grace stops it being reported as an outage; SHOP_SEARCH_MS raises this
// without a deploy.
const SEARCH_INTERVAL_MS = Number(process.env.SHOP_SEARCH_MS) || 8 * 1000;
const SEARCH_TERMS_PER_TICK = Number(process.env.SHOP_SEARCH_TERMS_PER_TICK) || 1;
// Resolving an unknown product costs one small request (~3.5KB), so it is bounded. In
// steady state almost every search result is already known and this stays at zero; it only
// works hard while a shop is first being mapped.
const SEARCH_DISCOVERY_PER_TICK = Number(process.env.SHOP_SEARCH_DISCOVERY_PER_TICK) || 2;
// The sweep is no longer a blind rotation — it spends its ten pages on the ones known to hold
// product — so this interval is now the refresh rate for everything we track, not just the
// slice that happened to come round. 45 minutes was chosen when it was a blind backstop and
// left Hobbiesville's sold-out Booster Box reading in-stock for over an hour.
const SWEEP_MS_WITH_SEARCH = Number(process.env.SHOP_SWEEP_BACKSTOP_MS) || 20 * 60 * 1000;
// Search prices are only believed once they have been shown to agree with prices read from
// products.json, which is the path whose cent/dollar unit is already established.
const PRICE_AGREEMENTS_REQUIRED = 5;

// The sweep cursor is an optimisation, so waiting on Redis for it must never stall a sweep.
// A disconnected ioredis client QUEUES commands rather than rejecting, so without this a
// blip would hang every shop poll until the adapter timeout rather than costing one
// redundant sweep. The timer is unref'd so it cannot hold the process open.
const CURSOR_REDIS_TIMEOUT_MS = 2000;
function withRedisTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error("redis timeout")), CURSOR_REDIS_TIMEOUT_MS);
      if (t.unref) t.unref();
    }),
  ]);
}

// How often a shop reads its WHOLE catalogue rather than just the newest page. New listings
// are caught on every poll regardless; this cadence only bounds how quickly a stock or price
// change deep in the catalogue is noticed.
// 15 minutes. Tried 5 to cut staleness; it put twelve shops into 429s and tripped six circuit
// breakers within eight minutes, so the arithmetic that said "1.55 req/s, plenty of headroom"
// was wrong about what these shops actually tolerate. A sweep is 6-10 requests in quick
// succession per shop, and tripling how often that burst happens is not the same load profile
// as the same request count spread evenly — which is the lesson from the very first outage,
// re-learned.
//
// Env-tunable so this can be moved without a deploy next time.
const FULL_SWEEP_MS = Number(process.env.SHOP_SWEEP_MS) || 15 * 60 * 1000;

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

// How deep a fast poll follows a collection that has more than one page. Bounded, because each
// page is a request on EVERY poll: at 8s a third page costs another 450 requests an hour per
// collection. Two pages cover a 500-product collection completely, which is every collection
// configured except kanzengames' pokemon-sealed-all (2,667) — that tail stays with the sweep.
const FAST_COLLECTION_PAGES = Number(process.env.SHOP_FAST_COLLECTION_PAGES) || 1;

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
    // Previously ignored: the hard page>10 cap overrode it, so a shop asking for 4,000
    // products silently received 2,500.
    this.maxProducts = Number(config.maxProducts) > 0 ? Number(config.maxProducts) : 2500;
    this._sweepCursor = 1;   // rotating window position
    this._sweepPages = SWEEP_PAGES_PER_RUN;  // narrowed on 429, widened again on success

    // Search state. The handle index is what lets a search result be matched to a product
    // pagination has already identified, instead of inventing a second key for it. Only
    // in-scope products reach it, so it stays small — on the order of a hundred per shop.
    this.searchTerms = config.searchTerms || SEARCH_TERMS;
    this._handleToSku = new Map();
    // Handles whose product has MORE THAN ONE variant. Predictive search reports availability per
    // PRODUCT, not per variant, so its answer cannot be attributed to any single variant of these
    // — see the guard in _searchProducts.
    this._multiVariantHandles = new Set();
    this._pageYield = new Map();   // page -> { n: in-scope found there, at: when }
    this._knownLastPage = 0;       // last page the explorer proved exists (0 = not yet known)
    // Read one collection per poll instead of all of them, for shops that refuse more than
    // one request per poll. Off unless the shop config asks for it.
    this.rotateCollections = config.rotateCollections === true;
    this._collectionCursor = 0;
    // How deep the fast poll follows a multi-page collection, per shop. Default 1 — following
    // is off unless a shop is known to tolerate the extra request per poll. Hobbiesville and
    // Kanzen Games both started returning 429s on their collection URLs at ~0.75 req/s, so
    // depth is opt-in per shop rather than global.
    this.fastCollectionPages = Number(config.fastCollectionPages) > 0
      ? Number(config.fastCollectionPages)
      : FAST_COLLECTION_PAGES;
    this._lastSearchAt = 0;
    this._searchRateLimited = false;
    this._searchPriceAgreements = 0;
    this._searchTermCursor = 0;
    this._sweepRateLimited = false;
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
    // Once keyword search is carrying the stock refresh, the pagination sweep becomes a
    // backstop for what search cannot see, and can run far less often. That is what keeps the
    // combined request rate per shop within a couple of percent of what it was before search
    // existed — these shops 429 readily, so the budget had to come from somewhere.
    const interval = this._searchActive() ? SWEEP_MS_WITH_SEARCH : FULL_SWEEP_MS;
    return now - this._lastFullSweep >= interval;
  }

  /**
   * Seed the handle index from the catalogue already in Redis.
   *
   * Without this, search can only refresh what the current process has happened to parse, and
   * a fast poll reads page 1 only — three in-scope products at Hobbiesville, none at all at
   * Kanzen Games, whose page 1 is KPop and Yu-Gi-Oh. The index would then fill at the pace of
   * a 45-minute backstop sweep, leaving search almost useless for hours after every deploy.
   *
   * Every product we already track carries its handle inside its URL, so the whole in-scope
   * set can be indexed at startup for one Redis read. Nothing is invented: these are SKUs
   * pagination established, which is exactly the identity rule search must respect.
   */
  async _loadHandleIndex() {
    if (this._handlesLoaded) return;
    this._handlesLoaded = true;
    try {
      const cached = await withRedisTimeout(state.getAllProducts(this.id));
      for (const [sku, product] of Object.entries(cached || {})) {
        const handle = String(product && product.url || '').split('/products/')[1];
        if (!handle) continue;
        const clean = handle.split(/[?#]/)[0];
        if (clean && !this._handleToSku.has(clean)) this._handleToSku.set(clean, sku);
      }
      if (this._handleToSku.size) {
        logger.info(`${this.name}: seeded ${this._handleToSku.size} handles for keyword search`);
      }
    } catch (err) {
      // Search simply stays idle until sweeps rebuild the index — degraded, not broken.
      logger.debug(`${this.name}: handle index seed failed: ${err.message}`);
    }
  }

  /**
   * The next collection to read, preferring one that is not being refused right now.
   *
   * Falls back to advancing normally when every collection is cooling: the request will fail
   * either way, and skipping forever would freeze the cursor and starve whichever collection
   * happens to recover first.
   */
  _nextCollection() {
    const n = this.collections.length;
    for (let tried = 0; tried < n; tried++) {
      const handle = this.collections[this._collectionCursor++ % n];
      const url = `${this.url}/collections/${handle}/products.json?limit=${FAST_PAGE_LIMIT}&page=1`;
      if (cooldownRemaining(url) === 0) return handle;
    }
    return this.collections[this._collectionCursor++ % n];
  }

  /** Search only carries the load once pagination has identified something for it to update. */
  _searchActive() {
    return this.collections.length === 0 && this.searchTerms.length > 0 && this._handleToSku.size > 0;
  }

  _isSearchDue(now = Date.now()) {
    return this._searchActive() && (now - this._lastSearchAt) >= SEARCH_INTERVAL_MS;
  }

  async fetchProducts() {
    const products = {};
    // Reset per poll. If every page comes back 304 we can tell the scheduler that nothing
    // moved, and it can skip the diff and the Redis round-trips entirely.
    this._anyPageChanged = false;
    // One Redis read on the first poll of the process, so search is useful immediately rather
    // than after a sweep cycle.
    await this._loadHandleIndex();

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
          // Some shops cannot afford a request per collection on every poll. Kanzen Games
          // refuses two: it ran clean on one collection and went straight back to
          // "Cooling down ... after 429" on every poll when a second was added, even though
          // that second collection is a 20-product response. The limit is the request COUNT,
          // not the payload.
          //
          // Rotating keeps the shop at one request per poll while still covering every
          // collection — each is read every collections.length polls, so at 8s two collections
          // are both seen inside 16 seconds. The alternative was leaving One Piece off the fast
          // path entirely, which is what the emergency fix had accidentally done.
          // Skip a collection whose endpoint is currently in a rate-limit cooldown. Without
          // this, rotation lands on the cooling one and the ENTIRE poll fails — Kanzen Games
          // lost every second poll to "Cooling down 279s after 429" on
          // one-piece-sealed-in-stock, which cost the Pokemon collection too even though its
          // own endpoint was answering perfectly. A cooling endpoint should cost that endpoint,
          // not the shop.
          const due = this.rotateCollections && this.collections.length > 1
            ? [this._nextCollection()]
            : this.collections;

          // In parallel, not in series. These shops pay one request per collection, and
          // fetching them one after another put Untouchables at 10.2s and Chimera Gaming at
          // 10.3s while every single-request shop sat comfortably under 9.6s — the only two
          // shops missing the target, purely because their requests were queued end to end.
          // The budget still paces them; this only stops the second waiting on the first.
          const pages = await Promise.all(due.map(handle => this._fetchPage(
            `${this.url}/collections/${handle}/products.json?limit=${FAST_PAGE_LIMIT}&page=1`,
          )));
          // Parse after the fetches so ordering stays deterministic regardless of which
          // collection returns first.
          for (const { products: page } of pages) {
            this._detectPriceUnit(page);
            for (const item of page) this.parseShopifyProduct(item, products);
          }

          // A FULL page means the collection has more, and stopping at 250 is what left 137
          // of Hobbiesville's 587 in-scope products outside the 8s poll. Only collections that
          // actually returned a full page are followed, so a shop pays a request per page that
          // exists rather than a fixed multiple of its collection count.
          let more = due
            .map((handle, i) => ((pages[i].products || []).length === FAST_PAGE_LIMIT ? handle : null))
            .filter(Boolean);
          for (let pageNo = 2; pageNo <= this.fastCollectionPages && more.length; pageNo++) {
            const extra = await Promise.all(more.map(handle => this._fetchPage(
              `${this.url}/collections/${handle}/products.json?limit=${FAST_PAGE_LIMIT}&page=${pageNo}`,
            )));
            const stillMore = [];
            extra.forEach(({ products: page }, i) => {
              for (const item of page) this.parseShopifyProduct(item, products);
              if ((page || []).length === FAST_PAGE_LIMIT) stillMore.push(more[i]);
            });
            more = stillMore;
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

        // Keyword search rides the fast poll rather than the sweep, because refreshing stock
        // for the whole in-scope set is the thing detection latency actually depends on.
        // Rotating pages had pushed a product on page 5 from a 15-minute check to a 2.5-hour
        // one; this brings the whole set back to one refresh per SEARCH_INTERVAL_MS.
        if (this._isSearchDue()) {
          this._lastSearchAt = Date.now();
          this._searchRateLimited = false;
          try {
            const n = await this._searchProducts(products);
            // Report the term actually searched, not the size of the list. Saying "across 14
            // terms" when one was queried misreads as a 14-request burst in the logs, which
            // is exactly the thing this cadence exists to avoid.
            logger.info(`${this.name}: keyword search refreshed ${n} product(s) ` +
              `(${this._handleToSku.size} identified)`);
          } catch (err) {
            // Search is an accelerator, never a dependency — the sweep still covers everything
            // it would have found, so a failure here must not fail the poll.
            logger.warn(`${this.name}: keyword search failed: ${err.message}`);
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
    let throttleErr = null;   // the original refusal, so its classification survives
    // Set when the catalogue sweep covered only part of the shop by design (rotating window),
    // as opposed to `incomplete`, which means something actually went wrong.
    let windowed = false;

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
        if (isRateLimited(err)) { throttled = true; throttleErr = throttleErr || err; }
        incomplete = true;
        logger.warn(`${this.name}: collection "${collection}" failed: ${err.message}`);
      }
    }

    // Method 2: Fetch all products (fallback if no collections configured OR collections returned nothing)
    if (this.collections.length === 0 || Object.keys(products).length === 0) {
      try {
        // A rotating window reads a slice, not the whole shop, so it is a PARTIAL view even
        // though the sweep itself succeeded. Saying so is what stops poll-adapter from
        // reading the pages outside the window as products that disappeared — which would
        // mark real stock out of stock and then fire it all back as false restocks.
        windowed = !(await this.fetchAllProducts(products));
      } catch (err) {
        if (isRateLimited(err)) { throttled = true; throttleErr = throttleErr || err; }
        incomplete = true;
        logger.warn(`${this.name}: /products.json failed: ${err.message}`);
      }
    }

    // Empty because the retailer refused us is a failed poll, not a catalogue of nothing.
    // Throwing keeps it out of the diff, the health ratio and the event stream alike.
    if (throttled && Object.keys(products).length === 0) {
      // Rethrow the ORIGINAL refusal, not a new message.
      //
      // This used to throw `${this.name}: rate limited — ...`, and that name prefix broke
      // every classifier downstream: isRateLimited and isSelfSkip are ^-anchored on
      // "Rate limited"/"Cooling down" (stealth-http.js), so a message starting with the shop
      // name matched neither. The scheduler therefore counted our OWN budget refusal or our
      // OWN cooldown as a retailer failure — consecutiveErrors++, healthy=false at 5, circuit
      // tripped at 5 — and every recovery probe landed in the same cooldown and threw the same
      // unrecognised message, so the breaker could never close. That is verbatim the loop
      // documented as already fixed for the other three rate-limit messages; this one string
      // slipped through.
      //
      // Rethrowing also preserves WHICH refusal it was: "Rate limited (429)" is the shop
      // refusing us and counts as a retailer signal, while "Rate limited (budget)" and
      // "Cooling down" are our own decisions and are exempt as self-skips.
      throw throttleErr || new Error(`Rate limited: ${this.name} — empty catalogue, not reporting it`);
    }

    // Partly-read sweep. Declaring it partial makes poll-adapter overlay what we DID read on
    // the cached catalogue instead of treating the gap as products that disappeared, which is
    // the difference between a quiet poll and a burst of false restocks.
    if (incomplete) {
      this._partialPoll = true;
      logger.warn(`${this.name}: sweep incomplete — treating as partial so stale cleanup is skipped`);
    } else if (windowed) {
      // Expected, not a fault: the shop is deeper than one window, so this run saw a slice.
      // No warning — it happens on most sweeps for the large shops and would be pure noise.
      this._partialPoll = true;
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
    // Three Shopify shapes, one fetch path — and therefore one budget, one proxy, one
    // cooldown and one ETag cache for every request this adapter makes:
    //   products.json          → .products
    //   search/suggest.json    → .resources.results.products
    //   products/<handle>.js   → the product itself
    const list = data.products
      || data?.resources?.results?.products
      || (data && data.id && Array.isArray(data.variants) ? [data] : []);
    if (res.headers.etag) this._etags.set(url, res.headers.etag);
    this._pageCache.set(url, list);
    return { products: list, changed: true };
  }

  /**
   * Refresh stock for known products using the shop's own search engine.
   *
   * This deliberately does NOT create products. Shopify's predictive search omits
   * variant.sku, while products.json supplies it and most shops populate it for real —
   * "POKE10-10311-114", "PKM-S-CI-053-RH-R-149076-3". Minting a key here would therefore
   * invent a second identity for a product we already track, and every one of those would
   * surface as a brand new listing. So search updates what pagination has already identified,
   * matched on the product handle, and anything unknown is left for the sweep to discover.
   * Nothing is lost by that: a genuinely new listing appears on page 1, which the fast poll
   * reads every poll.
   *
   * @returns {number} how many known products were refreshed
   */
  async _searchProducts(products) {
    if (!this._handleToSku.size) return 0;   // nothing identified yet; sweep runs first
    let refreshed = 0;
    let discovered = 0;   // bounded per tick, see SEARCH_DISCOVERY_PER_TICK

    // Take the next few terms and remember where we stopped, so successive polls walk the
    // whole list instead of repeating its head.
    const terms = [];
    for (let i = 0; i < Math.min(SEARCH_TERMS_PER_TICK, this.searchTerms.length); i++) {
      terms.push(this.searchTerms[this._searchTermCursor % this.searchTerms.length]);
      this._searchTermCursor = (this._searchTermCursor + 1) % this.searchTerms.length;
    }

    for (const term of terms) {
      const url = `${this.url}/search/suggest.json?q=${encodeURIComponent(term)}`
        + `&resources[type]=product&resources[limit]=${SEARCH_RESULT_LIMIT}`
        + '&resources[options][unavailable_products]=show';
      let results;
      try {
        results = (await this._fetchPage(url)).products;
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        logger.warn(`${this.name}: search rate limited on "${term}" — keeping ${refreshed} refreshed`);
        this._searchRateLimited = true;
        break;
      }
      if (!Array.isArray(results)) continue;

      for (const item of results) {
        // A multi-variant product never resolves to a single sku here, so its availability is
        // read from its own page below rather than guessed from the product-level search flag.
        const sku = this._multiVariantHandles.has(item.handle) ? null : this._handleToSku.get(item.handle);
        if (!sku) {
          // An in-scope product search can see but pagination has not reached. Measured at
          // both shops asked about: every one of twenty results was a real sealed product
          // — Stellar Crown ETB, Mega Evolution ETB — and all twenty were being discarded,
          // because the rotation had not walked deep enough to identify them yet.
          //
          // Resolving it here rather than waiting for the sweep is what makes search useful
          // on a shop whose product sits on page 40. It is deliberately NOT keyed from the
          // search result: products/<handle>.js returns the same product id, variant id and
          // sku that products.json does, so the key derived below is identical to the one
          // pagination would produce, and no second identity can appear.
          if (isInScopeName(item.title, this.extraGameNames) && discovered < SEARCH_DISCOVERY_PER_TICK) {
            discovered++;
            try {
              const { products: one } = await this._fetchPage(`${this.url}/products/${item.handle}.js`);
              for (const full of one) this.parseShopifyProduct(this._normaliseAjaxPrices(full), products);
            } catch (err) {
              if (isRateLimited(err)) { this._searchRateLimited = true; return refreshed; }
              logger.debug(`${this.name}: could not resolve "${item.handle}": ${err.message}`);
            }
          }
          continue;
        }
        const existing = products[sku];
        const price = this._searchPrice(item, existing);
        products[sku] = {
          ...(existing || {}),
          sku,
          name: item.title,
          url: existing?.url || `${this.url}/products/${item.handle}`,
          image: existing?.image || item.featured_image?.url || item.image || '',
          price,
          currency: 'CAD',
          inStock: item.available === true,
          canAddToCart: item.available === true,
          shipsToHome: true,
          // Stamp identity at the SOURCE so a product keyword-search discovers before the slower
          // full sweep covers it is not a bare row — delivery's retailerIdFromName crashed on the
          // undefined and lost the alert (135 bare Titan Toyz rows). ONLY retailerId + retailer,
          // NOT a full classify(): classify() also sets category='other' when classifyCategory finds
          // no franchise word, and routeEvent permanently BLOCKS 'other'. isInScopeName accepts SET
          // names ("Chaos Rising ETB") that classifyCategory cannot, so a full classify() here would
          // silence 6 real in-stock Pokemon products (measured across all 12 Shopify catalogues).
          // Category is left as-is (its today's bypass preserved). Not a routeEvent repair either —
          // stamping here keeps the dedup key stable (deliver() normalises before filterDuplicates).
          retailerId: this.id,
          retailer: this.name,
          // lastSeen must be stamped even though classify() is skipped. poll-adapter's
          // confirmations ask "is this a genuine re-read, or a row replayed from cache?" by
          // comparing lastSeen against the previous observation. A row that never carries the
          // field would answer "replayed" forever, the out-of-stock hold would pin
          // inStock:true permanently, and this shop could never record a sell-out. That is
          // exactly the shape this lane produces for a product NOT on page 1 — its whole
          // reason to exist — so the omission would be silent and total. The guard also fails
          // open on a missing value, but both halves are needed: this is the honest signal.
          lastSeen: Date.now(),
        };
        refreshed++;
      }
    }
    return refreshed;
  }

  /**
   * Put a products/<handle>.js product into the SAME price unit as products.json.
   *
   * Shopify's Ajax API always quotes cents. products.json does not: hobbiesville quotes cents
   * there (696/696 prices exact multiples of 100) while kanzengames quotes dollars. Handing a
   * raw Ajax price to parseShopifyProduct therefore skipped or double-applied the store's
   * divisor depending on the shop — kanzengames reported a $179.95 Elite Trainer Box as
   * $17,995, caught by spot-checking live listings against what we had stored.
   *
   * When the store's unit is not yet established the price is dropped rather than guessed.
   * A missing price costs one field on an alert; a price wrong by 100x pollutes price history
   * and fires a false price-change alert, which is far worse.
   */
  _normaliseAjaxPrices(item) {
    const variants = (item.variants || []).map((v) => {
      const cents = Number(v.price);
      if (!Number.isFinite(cents)) return { ...v, price: null };
      if (!this._priceUnitLocked) return { ...v, price: null };
      // parseShopifyProduct divides by 100 for a cents store, so hand it cents there and
      // dollars everywhere else — either way the product ends up in dollars.
      return { ...v, price: this._pricesAreCents ? cents : cents / 100 };
    });
    return { ...item, variants };
  }

  /**
   * Price from a search result, but only once it has earned trust.
   *
   * The two endpoints do not agree on units. products.json quotes hobbiesville in cents
   * (696/696 prices exact multiples of 100) while predictive search returns the formatted
   * "579.95" for the same catalogue. Applying the store's cent divisor to a search price
   * would report a $579.95 booster box as $5.79.
   *
   * So a search price is compared against the price pagination already established for the
   * same product, and is only adopted after enough of those comparisons agree. Until then
   * the known price is kept and only availability is taken — a missing price costs one field,
   * a wrong one pollutes price history and can fire a false price-drop alert.
   */
  _searchPrice(item, existing) {
    const parsed = normalizePrice(String(item.price ?? ''));
    const known = existing && typeof existing.price === 'number' ? existing.price : null;

    if (Number.isFinite(parsed) && parsed > 0 && known !== null) {
      const agrees = Math.abs(parsed - known) / known < 0.01;
      if (agrees) this._searchPriceAgreements++;
      else this._searchPriceAgreements = -Infinity;   // one disagreement disqualifies the shop
    }
    const trusted = this._searchPriceAgreements >= PRICE_AGREEMENTS_REQUIRED;
    if (trusted && Number.isFinite(parsed) && parsed > 0) return parsed;
    return known;
  }

  async fetchCollection(handle, products) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.url}/collections/${handle}/products.json?limit=${this.pageLimit}&page=${page}`;
      let data;
      try {
        data = { products: (await this._fetchPage(url)).products };
      } catch (err) {
        // Chimera Gaming reads a collection rather than the catalogue, and it was hitting 429
        // on this path while the catalogue path had already learned to back off. Same rule:
        // keep what we read, let the caller treat the collection as incomplete. Page 1 still
        // propagates, because a collection we cannot open at all is a real failure.
        if (!isRateLimited(err) || page === 1) throw err;
        logger.warn(`${this.name}: rate limited on collection "${handle}" page ${page} — ` +
          `keeping the ${page - 1} page(s) already read`);
        break;
      }

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

  /**
   * Sweep the catalogue through a ROTATING WINDOW.
   *
   * This used to stop dead at `page > 10`, a flat 2,500-product ceiling that ignored the
   * configured maxProducts entirely — kanzengames asks for 4,000 and silently got 2,500.
   * Hobbiesville is the case that showed what it costs: the shop carries 13,750 products
   * across 55 pages, and of its in-scope sealed products only 21 sat inside the first ten
   * pages while 109 sat beyond them. Several of those were in stock. They could never be
   * alerted, because nothing ever looked at them.
   *
   * Reading all 55 pages in one go is not the fix. A sweep is already a burst of requests in
   * quick succession, and that burst is what put twelve shops into 429s when the sweep cadence
   * was tripled — this very scan hit HTTP 429 at page 56. So the window stays at ten pages,
   * exactly the old maximum, and MOVES: each sweep starts where the last one stopped and wraps
   * at the end. Same request rate, whole catalogue covered over successive sweeps.
   *
   * Page 1 is still read on every poll by the fast path, so a NEW listing is caught as
   * quickly as before regardless of where the window happens to be.
   *
   * @returns {boolean} true only if this run read the catalogue from page 1 through to its
   *   end, which is the only case where the caller may treat the result as a complete view.
   */
  /**
   * Which pages this sweep should spend its budget on.
   *
   * Plain rotation gives every page equal time, and most pages hold nothing we track — so a
   * product we DO track waits for the whole catalogue to come round. Hobbiesville's Mega Set 7
   * Booster Box sat in-stock in our data for over an hour after the shop had sold out, because
   * nothing re-read its page: the fast poll only reads page 1, search only refreshes the ten
   * products a query surfaces, and the backstop sweep was rotating 56 pages at 45 minutes a
   * turn. Every part was working; nothing was actually looking at it.
   *
   * The budget therefore splits:
   *   - one slot always walks sequentially, so unread pages are still discovered and a page
   *     that has only ever been empty is eventually re-checked
   *   - the rest go to pages last seen holding in-scope product, stalest first
   *
   * Unread pages take priority over that second group while a shop is still being mapped, so
   * a cold start behaves exactly like the plain rotation it replaces.
   */
  _selectSweepPages(maxPages, budget) {
    const pages = [];
    const explore = Math.min(Math.max(this._sweepCursor || 1, 1), maxPages);
    pages.push(explore);

    // Discovery: pages never read at all. Mapping an unknown shop is worth the whole budget.
    for (let p = 1; p <= maxPages && pages.length < budget; p++) {
      if (this._pageYield.has(String(p))) continue;
      if (!pages.includes(p)) pages.push(p);
    }

    // Exploitation: pages that actually hold product, oldest-checked first. This is the point
    // of the sweep — Hobbiesville's sold-out Booster Box read in-stock for over an hour when
    // a blind rotation gave page 40 the same priority as the pages holding what we track.
    if (pages.length < budget) {
      const productive = [];
      for (const [p, info] of this._pageYield) {
        const page = Number(p);
        if (page <= maxPages && info && info.n > 0) productive.push({ page, at: info.at || 0 });
      }
      productive.sort((a, b) => a.at - b.at);
      for (const { page } of productive) {
        if (pages.length >= budget) break;
        if (!pages.includes(page)) pages.push(page);
      }
    }

    // Re-check of pages known EMPTY, last and strictly rationed.
    //
    // A shop grows, so a page that was empty last week may not be now — but this must never
    // compete with the pages that hold product. Ranking stale-barren pages as discovery put
    // fifty-three empty pages ahead of the two productive ones on a mapped shop, which is the
    // exact staleness the yield ranking exists to prevent. A couple per sweep walks the whole
    // catalogue over time and costs almost nothing.
    if (pages.length < budget) {
      const now = Date.now();
      const stale = [];
      for (const [p, info] of this._pageYield) {
        const page = Number(p);
        if (page > maxPages || !info || info.n > 0) continue;
        if (now - (info.at || 0) > BARREN_RECHECK_MS) stale.push({ page, at: info.at || 0 });
      }
      stale.sort((a, b) => a.at - b.at);   // longest-unchecked first
      for (const { page } of stale.slice(0, BARREN_RECHECKS_PER_SWEEP)) {
        if (pages.length >= budget) break;
        if (!pages.includes(page)) pages.push(page);
      }
    }
    return { pages, explore };
  }

  async fetchAllProducts(products) {
    await this._loadSweepCursor();
    this._sweepRateLimited = false;   // describes THIS run only
    // maxProducts is a CEILING from config, not a measurement: 25000 implies 100 pages while
    // the real catalogue is nearer 64. The sweep spent its budget exploring pages that have
    // never existed, and with ten pages per run a 100-page space takes ten sweeps (3+ hours) to
    // map — which is why the cold-read burst that earns the 429s persisted. Once the explorer
    // has actually seen where the catalogue ends, look one page past it and no further; that
    // one page is what notices the shop growing.
    const configuredMax = Math.max(1, Math.ceil(this.maxProducts / this.pageLimit));
    const maxPages = this._knownLastPage
      ? Math.min(configuredMax, this._knownLastPage + 1)
      : configuredMax;
    const { pages: plan, explore } = this._selectSweepPages(maxPages, this._sweepPages);
    let pagesRead = 0;
    let reachedEnd = false;

    for (const page of plan) {
      const url = `${this.url}/products.json?limit=${this.pageLimit}&page=${page}`;
      let data;
      try {
        data = { products: (await this._fetchPage(url)).products };
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        // A request WE declined to send is not the shop pushing back. Our own token bucket
        // being busy, or a cooldown from an earlier 429, used to narrow this window exactly as
        // a real 429 does — and because _sweepRateLimited then blocks the widen-back, a shop
        // under nothing worse than budget contention sweeps 2 pages per run permanently, losing
        // catalogue coverage for a limit we imposed on ourselves. Skip and try again next run.
        if (isSelfSkip(err)) {
          logger.debug(`${this.name}: page ${page} skipped by our own backoff — window unchanged`);
          break;
        }
        // The shop pushed back. Two things follow, and both matter.
        //
        // First, narrow the window. Rotating into pages that have never been read replaced a
        // decade of cheap 304s with full 250-product responses — the same REQUEST count, far
        // more work for the origin — and 429s went from 1 a day to 38. Fewer pages per sweep
        // is the lever that actually reduces that load; the rotation still covers everything,
        // just more slowly.
        this._sweepPages = Math.max(MIN_SWEEP_PAGES, Math.floor(this._sweepPages / 2));
        this._sweepRateLimited = true;
        logger.warn(`${this.name}: rate limited on page ${page} — narrowing sweep to ` +
          `${this._sweepPages} page(s) per run`);
        // Second, do NOT advance past the page we failed to read, or the rotation would
        // silently skip it and its products would stay invisible.
        this._sweepCursor = page;
        await this._saveSweepCursor();

        // Third, keep page 1 as the freshness anchor. If the window was deep in the catalogue
        // and got nothing, returning empty would let poll-adapter merge the cache forward and
        // report a healthy poll on stale data — a shop could be refusing us for hours and
        // still look fine. Page 1 is the cheapest read there is (usually a 304), so fall back
        // to it. If page 1 is refused too, the shop really is unreachable and the error
        // propagates as a failed poll, which is the honest outcome.
        if (pagesRead === 0 && page !== 1) {
          const p1 = `${this.url}/products.json?limit=${this.pageLimit}&page=1`;
          const first = { products: (await this._fetchPage(p1)).products };
          this._detectPriceUnit(first.products);
          for (const item of first.products || []) {
            if (this.searchKeywords.length > 0) {
              const text = `${item.title} ${item.product_type} ${item.tags?.join(' ')}`.toLowerCase();
              if (!this.searchKeywords.some((kw) => text.includes(kw.toLowerCase()))) continue;
            }
            this.parseShopifyProduct(item, products);
          }
        }
        return false;
      }

      if (!data.products || data.products.length === 0) {
        // Only the sequential explorer proves where the catalogue ends. A productive page
        // coming back empty just means its contents shifted.
        // ANY empty page proves the catalogue is shorter than this, not just the explorer's.
        // Pages are contiguous, so page N empty means fewer than 250*(N-1) products right now.
        // Learning this only from the explorer took one page per sweep — 64 sweeps, over 20
        // hours, for a 64-page shop — so the cap never arrived in time to matter. The discovery
        // pass reads up to ten unread pages a sweep, and any one of them coming back empty now
        // collapses the search space immediately.
        if (page === explore) reachedEnd = true;
        const end = Math.max(1, page - 1);
        this._knownLastPage = this._knownLastPage ? Math.min(this._knownLastPage, end) : end;
        this._pageYield.set(String(page), { n: 0, at: Date.now() });
        continue;
      }

      // Judge the store's price unit on the UNFILTERED page — the keyword filter can leave
      // too few prices to read the distribution from.
      this._detectPriceUnit(data.products);

      const before = Object.keys(products).length;
      for (const item of data.products) {
        // Filter by keywords if configured
        if (this.searchKeywords.length > 0) {
          const text = `${item.title} ${item.product_type} ${item.tags?.join(' ')}`.toLowerCase();
          const match = this.searchKeywords.some(kw => text.includes(kw.toLowerCase()));
          if (!match) continue;
        }
        this.parseShopifyProduct(item, products);
      }
      // Remember what this page was worth, so the next sweep spends its budget where the
      // product actually is instead of treating all 56 pages as equally interesting.
      this._pageYield.set(String(page), { n: Object.keys(products).length - before, at: Date.now() });

      pagesRead++;
      // A short page is the last one the shop has.
      // A FULL page is a LOWER bound: it proves the catalogue reaches at least this far, and
      // says nothing about where it stops. It must never lower the cap — an earlier version let
      // it set the cap outright, so after one sweep of full pages the ceiling collapsed to the
      // highest page seen and the shop could never explore past it. The existing rotation test
      // caught that. It only ever RAISES a cap that a shrink had set too low, which is how a
      // shop that grows recovers its coverage.
      if (data.products.length >= this.pageLimit) {
        if (this._knownLastPage && page >= this._knownLastPage) this._knownLastPage = page;
      } else if (page === explore) {
        reachedEnd = true;
        this._knownLastPage = page;
      }
    }

    // The explorer advances one page per sweep and wraps at the end.
    this._sweepCursor = (reachedEnd || explore >= maxPages) ? 1 : explore + 1;

    // A clean run earns one page back, so a shop that was briefly busy returns to full speed
    // instead of being punished forever by one bad minute. The flag is reset at the START of
    // each run, so it describes THIS sweep — leaving it set from the previous one meant the
    // first clean sweep after a 429 never widened.
    if (!this._sweepRateLimited && this._sweepPages < SWEEP_PAGES_PER_RUN) {
      this._sweepPages += 1;
      logger.info(`${this.name}: sweep widened back to ${this._sweepPages} page(s) per run`);
    }

    await this._saveSweepCursor();

    // Complete only when this ONE run read every page the shop has — true for a small shop
    // whose whole catalogue fits in the budget, false for a large one, where the caller must
    // treat the result as partial or the pages outside this sweep look like products that
    // vanished.
    const planned = new Set(plan);
    for (let p = 1; p <= maxPages; p++) {
      if (!planned.has(p)) return false;
    }
    return true;
  }

  /**
   * The rotating window's position, kept in Redis rather than in memory.
   *
   * A deep shop needs ten sweeps to cycle — two and a half hours at the current cadence — and
   * an in-memory cursor restarts at page 1 on every deploy. A shop would then re-read its first
   * ten pages forever and never reach the pages the rotation exists to cover, which is the
   * exact bug this change set out to fix. Pokemon Center lost four scheduling maps the same
   * way earlier, so it is a repeat of a known failure rather than a hypothetical one.
   *
   * Redis failures are swallowed: a lost cursor costs one redundant sweep, while a throwing
   * poll costs the whole store.
   */
  async _loadSweepCursor() {
    if (this._cursorLoaded) return;
    this._cursorLoaded = true;
    try {
      const raw = await withRedisTimeout(state.getRedis().get(`tcg:sweepcursor:${this.id}`));
      if (!raw) return;
      // Earlier deployments stored a bare page number, so accept both shapes.
      if (/^\d+$/.test(raw)) { this._sweepCursor = Number(raw); return; }
      const saved = JSON.parse(raw);
      if (Number.isFinite(saved.cursor) && saved.cursor >= 1) this._sweepCursor = saved.cursor;
      // Without the handle index, search would sit idle after every deploy until a sweep had
      // rebuilt it — up to 45 minutes of doing nothing.
      if (saved.handles && typeof saved.handles === 'object') {
        for (const [h, sku] of Object.entries(saved.handles)) this._handleToSku.set(h, sku);
      }
      if (Number.isFinite(saved.priceAgreements)) this._searchPriceAgreements = saved.priceAgreements;
      // Where the catalogue actually ends. Without this a restart goes back to exploring the
      // config ceiling, which is the whole 100-page space again.
      if (Number.isFinite(saved.lastPage) && saved.lastPage >= 1) this._knownLastPage = saved.lastPage;
      // Which pages hold product. Without this the sweep relearns the whole catalogue after
      // every deploy, spending its budget on empty pages while tracked products go stale.
      if (saved.yield && typeof saved.yield === 'object') {
        for (const [p, info] of Object.entries(saved.yield)) this._pageYield.set(p, info);
      }
      // Pages known to be EMPTY, stored as page -> timestamp. Restoring these is what stops a
      // restart re-exploring the whole catalogue; they age out via BARREN_RECHECK_MS.
      if (saved.barren && typeof saved.barren === 'object') {
        for (const [p, at] of Object.entries(saved.barren)) {
          if (!this._pageYield.has(p)) this._pageYield.set(p, { n: 0, at: Number(at) || 0 });
        }
      }
    } catch { /* first sweep just starts at page 1 with no history */ }
  }

  async _saveSweepCursor() {
    try {
      const handles = {};
      for (const [h, sku] of this._handleToSku) handles[h] = sku;
      // Only pages that actually yielded product are worth carrying — a shop with a hundred
      // empty pages should not rewrite a hundred zeroes on every sweep.
      const productive = {};
      const barren = {};
      for (const [p, info] of this._pageYield) {
        if (!info) continue;
        if (info.n > 0) productive[p] = info;
        // Barren pages are kept too, but as page -> timestamp only. The original reasoning —
        // "a shop with a hundred empty pages should not rewrite a hundred zeroes" — was right
        // about the cost of full objects and wrong about dropping them: selection treats an
        // unknown page as never-read, so forgetting them sent every restart back through ten
        // cold full-payload fetches. A bare number each is ~8 bytes and buys that back.
        else barren[p] = info.at || 0;
      }
      const payload = JSON.stringify({
        cursor: this._sweepCursor,
        lastPage: this._knownLastPage || 0,
        handles,
        yield: productive,
        barren,
        priceAgreements: Number.isFinite(this._searchPriceAgreements) ? this._searchPriceAgreements : 0,
      });
      await withRedisTimeout(state.getRedis().set(`tcg:sweepcursor:${this.id}`, payload));
    } catch { /* position is an optimisation, never worth failing a poll for */ }
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
    // The shared scope rule — identical to the one the big seven use. isNonTcg above is a
    // coarse category screen that deliberately RESCUED every trading card game and singles
    // ('yugioh', 'lorcana', 'mtg', 'single', 'psa ', 'graded'), which is why the shops were
    // alerting on MTG, Lorcana, hockey boxes and 50,000 single cards. Scope is decided here.
    if (!isInScopeName(item.title, this.extraGameNames)) return;

    // Each Shopify product can have multiple variants
    for (const variant of item.variants) {
      const inStock = variant.available === true;
      const sku = variant.sku || `${item.id}-${variant.id}`;
      // Remember which product this handle belongs to. Predictive search returns a handle but
      // no variant.sku, so this index is the only safe way for a search result to update THIS
      // product rather than register itself as a new one.
      //
      // ONLY for single-variant products. "First variant wins" was the original rule and it is
      // what flooded a client channel: ZardoCards' "Celebrations ETB" has two variants, the handle
      // resolved to the "Imperfect (1x)" one (ZC-105), and _searchProducts then wrote the
      // PRODUCT-level `available` onto that variant. The sibling variant being purchasable made
      // ZC-105 read as a restock over and over — 12+ identical alerts, one every 10 minutes,
      // spaced exactly by the dedup TTL because dedup was the only thing holding it back.
      //
      // A multi-variant handle is deliberately left UNMAPPED so search falls through to the
      // resolve-by-page branch below, which reads real per-variant availability.
      if (item.handle) {
        if (item.variants.length > 1) {
          this._multiVariantHandles.add(item.handle);
          this._handleToSku.delete(item.handle);
        } else if (!this._handleToSku.has(item.handle) && !this._multiVariantHandles.has(item.handle)) {
          this._handleToSku.set(item.handle, sku);
        }
      }
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

      // TWO VARIANTS CAN SHARE ONE SKU, and then this key is ambiguous.
      //
      // ZardoCards lists "Celebrations ETB" as variant 50526702600504 "Normal (1x)" (available,
      // $307) and variant 50984122843448 "Imperfect (1x)" (NOT available, $276) — both carrying
      // the sku "ZC-105". Writing blind meant last-variant-wins, so this row's inStock depended on
      // whichever variant the response happened to list last. Different code paths landed on
      // different answers, the row oscillated, and every flip to true was a fresh RESTOCK: 12+
      // identical alerts into the client's channel, paced only by the dedup TTL. The store's own
      // data never moved — measured 42 consecutive samples, zero changes.
      //
      // Resolve deterministically instead: AVAILABLE WINS. A customer looking at that page can buy
      // the Normal copy, so "in stock" is the honest answer, and the row stops depending on
      // response ordering. Ties keep the first variant seen, so the result is stable either way.
      const prior = products[product.sku];
      if (prior && prior._productId === item.id && prior._variantId !== product._variantId) {
        if (prior.inStock && !product.inStock) continue;      // keep the buyable one
        if (prior.inStock === product.inStock) continue;      // deterministic tie-break: first wins
      }
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
