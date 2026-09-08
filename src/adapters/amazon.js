const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, isTCGProduct, sleep } = require('../utils/helpers');
const { getProxyUrl, getIspProxyRoundRobin, ispPoolSize } = require('../core/proxy');

const { stealthGet, _clearCache } = require('../utils/stealth-http');
const state = require('../core/state');
const { searchQueries: BASE_QUERIES, setQueries: SET_QUERIES } = require('../config/products.json');
const SEARCH_QUERIES = [...BASE_QUERIES, ...(SET_QUERIES || [])];

// Game names that we track — Amazon results MUST match one of these.
// Scoped to Pokemon and One Piece to match every other adapter.
// One shared scope rule across every retailer — see src/utils/scope.js. It used to live
// here, which is exactly why Walmart never had one.
const {
  GAME_NAMES,
  ACCESSORY_KEYWORDS,
  PRINT_KEYWORDS,
  isInScopeName,
} = require('../utils/scope');

// If more than this share of the stored catalogue looks out of scope, the scope test is the
// thing that is wrong. Amazon's real run removed 159 of 371 (43%); Walmart's first run has
// 190 of 360 (53%), which is genuine — a filter applied for the first time to a catalogue
// that never had one. So this guards against a total regression, not a large cleanup: it
// aborts only when nearly everything fails, or when too little would be left standing.
const PURGE_MAX_SHARE = 0.9;
const PURGE_MIN_KEPT = 25;

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/**
 * Do two titles describe the same listing?
 *
 * Amazon serves one product under several strings: search aria-labels drop accented brand
 * prefixes ("Pokémon TCG: X" -> "TCG: X"), AOD titles carry zero-width padding, and the
 * separator moves between em dash, hyphen and nothing. A literal comparison would call every
 * product a relist. Compared on letters and digits alone with accents folded, and counted as
 * the same product when either title contains the other — which is the relationship a
 * truncated or prefix-stripped rendering always has to the full title.
 */
function sameProductName(a, b) {
  const norm = s => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  // Nothing to compare on. Saying "same" here means a missing title never triggers a rename;
  // the scope test above is what protects against a listing that actually changed.
  if (!x || !y) return true;
  return x.includes(y) || y.includes(x);
}

// How often to run the paid ScraperAPI search for NEW listings. This is the whole
// ScraperAPI bill: 3 queries x 5 credits per run. It does NOT affect restock speed —
// _monitorKnownAsins re-checks every known ASIN on every poll, free, regardless.
/**
 * How many search queries go out per poll, and how long to stay quiet when Amazon refuses.
 *
 * Firing all four queries every 6 seconds is 0.67 req/sec sustained against one endpoint.
 * Measured 2026-09-05: Amazon tolerated that for roughly fourteen hours and then 503'd the IP.
 * Rotating one query per poll is the same coverage at a quarter of the load — every query is
 * refreshed every 24s — and it arrives smoothly instead of in bursts of four, which is the
 * same change that fixed the Shopify shops the same day.
 *
 * The old backoff skipped every OTHER cycle, which is not backing off: it still sent four
 * blocked requests every twelve seconds forever. A block under light load decayed on its own
 * in ~23 minutes; the continuously re-poked one had not decayed after two hours.
 */
const QUERIES_PER_POLL = Number(process.env.AMAZON_QUERIES_PER_POLL) || 1;
const SEARCH_BACKOFF_MS = [60000, 180000, 300000, 600000, 900000];

const DISCOVERY_INTERVAL_DEFAULT = 30 * 60 * 1000;
const DISCOVERY_INTERVAL_FLOOR = 5 * 60 * 1000;
const AOD_COOLDOWN_MS = 10 * 60 * 1000;

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    this._knownProducts = new Map(); // ASIN → classified product (persists between polls)
    this._lastDiscoveryAt = 0;       // timestamp of last ScraperAPI discovery
    this._monitorSuccessRate = 0;    // track product page stealth success %
    this.watchlist = new Set(config.watchlist || []); // fast-polled by the scheduler
    this._aodCooldownUntil = 0;      // set when Amazon starts 503ing the offer endpoint
    this._lastFetchThrottled = false;
    this._searchWindow = [];         // rolling free-search success
    this._searchSkip = 0;
    this._queryCursor = 0;
    this._searchStrikes = 0;
    this._searchBlockedUntil = 0;
    this._lastAodSweepAt = 0;
    this._deriveTiming();

    // Shared query set (src/config/products.json) — identical to Walmart and Best Buy
    this.searchQueries = config.searchQueries || SEARCH_QUERIES;
  }

  _deriveTiming() {
    this.discoveryIntervalMs = this.timingValue('discoveryIntervalMs', DISCOVERY_INTERVAL_DEFAULT, DISCOVERY_INTERVAL_FLOOR);
    // The AOD offer sweep is throttled hard by Amazon, so it runs far less often than search
    this.aodSweepIntervalMs = this.timingValue('aodSweepIntervalMs', 5 * 60 * 1000, 60 * 1000);
  }

  /**
   * Check one ASIN through Amazon's All-Offers-Display AJAX endpoint.
   *
   * This is the same trick that fixed Walmart: the full /dp/ page is ~1.9 MB and is
   * currently served as a 3.7 KB "continue shopping" interstitial anyway, while AOD
   * returns ~30 KB of exactly what we need — title, price, seller, offer listing id —
   * and is not gated. 15 ASINs every 2 minutes drops from ~20 GB/day to ~0.3 GB/day,
   * and the offer id it hands back saves the 10-credit enrichment call per alert.
   */
  async _stealthCheckAsin(asin) {
    const url = `https://www.amazon.ca/gp/product/ajax/aodAjaxMain/?asin=${asin}&pc=dp`;
    const proxyUrl = getProxyUrl('residential');

    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 12000,
        rawHeaders: true,
        headers: {
          'Accept': 'text/html,*/*;q=0.8',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': `https://www.amazon.ca/dp/${asin}`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      this._lastFetchThrottled = false;
      // Amazon answers an over-used AOD endpoint with a 503 that redirects to /error/500
      if (html && html.includes('/error/500')) {
        this._lastFetchThrottled = true;
        return null;
      }
      if (!html || html.length < 1000) return null;
      if (html.includes('Click the button below to continue shopping')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      // Bot detection / CAPTCHA pages
      if (html.includes('Robot Check') || html.includes('captcha') ||
          html.includes('Type the characters') || html.includes('Sorry, we just need to make sure')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      return this._parseAod(html, asin);
    } catch (err) {
      // stealthGet throws on 503 before we can read the body
      this._lastFetchThrottled = /50[03]|Blocked after/.test(err.message || '');
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  /**
   * Parse the AOD fragment. No offer block at all means nobody is selling it — that is
   * a genuine out-of-stock, not a parse failure, so it returns a result rather than null.
   */
  _parseAod(html, asin) {
    const titleMatch = html.match(/id="aod-asin-title-text"[^>]*>\s*([^<]+?)\s*</);
    const name = titleMatch ? decodeEntities(titleMatch[1].trim()) : null;

    // Buy-box offer id — doubles as the "is anything purchasable" signal
    // The OLID is a base64 token containing + / and =, and Amazon emits it percent-encoded.
    // It is stored DECODED — one canonical internal form — and re-encoded exactly once
    // wherever it is put in a URL or shown for copying. Storing it encoded instead would
    // double-encode at those sites (%2B -> %252B) and select a different offer.
    // decodeURIComponent throws on a malformed escape, which would take out the whole parse.
    const olidMatch = html.match(/name="items\[0\.base\]\[offerListingId\]"\s*value="([^"]+)"/);
    let olid = null;
    if (olidMatch) {
      try { olid = decodeURIComponent(olidMatch[1]); } catch { olid = olidMatch[1]; }
    }

    let price = null;
    const apexPrice = html.match(/apex-pricetopay-accessibility-label"[^>]*>\s*\$?([\d,]+\.\d{2})/);
    if (apexPrice) price = normalizePrice(apexPrice[1]);
    if (!price) {
      const whole = html.match(/class="a-price-whole">\s*([\d,]+)/);
      const frac = html.match(/class="a-price-fraction">(\d+)/);
      if (whole) price = parseFloat(`${whole[1].replace(/,/g, '')}.${frac ? frac[1] : '00'}`);
    }

    // "Sold by" is a label/value pair; the value is the next a-color-base span after it
    let seller = null;
    const soldByIdx = html.indexOf('aod-offer-soldBy');
    if (soldByIdx !== -1) {
      const block = html.slice(soldByIdx, soldByIdx + 900);
      const linked = block.match(/<a[^>]*>\s*([^<]{2,60}?)\s*<\/a>/);
      const plain = block.match(/a-color-base[^>]*>\s*([^<]{2,60}?)\s*</);
      seller = decodeEntities((linked ? linked[1] : plain ? plain[1] : '').trim()) || null;
    }

    const imgMatch = html.match(/id="aod-asin-image-id"[^>]*src="([^"]+)"/)
      || html.match(/src="([^"]+)"[^>]*id="aod-asin-image-id"/);

    const inStock = !!olid && price != null;
    if (!name && !inStock) return null; // nothing parsed at all — treat as a failed fetch

    return { asin, name, price, inStock, image: imgMatch ? imgMatch[1] : '', olid, seller };
  }

  /**
   * Search runs every poll and is now the detection path: it is free, and it reports a
   * brand-new listing the same cycle it appears rather than up to 30 minutes later.
   * The AOD sweep only tops up offer ids and sellers, and only when Amazon is not
   * throttling it — search alone is enough to fire a restock alert.
   */
  async fetchProducts() {
    const products = {};
    const now = Date.now();

    // Amazon throttles by endpoint, as the AOD sweep found out the hard way. If search starts
    // failing, go properly quiet rather than hammering it into a deeper block.
    //
    // Skipping every OTHER cycle was not backing off at all: at a 6s interval it still sent
    // four blocked requests every twelve seconds, indefinitely. Measured 2026-09-05 — Amazon
    // blocked this IP at 02:54 and recovered on its own within 23 minutes under light load,
    // then blocked again at ~16:13 and was STILL blocked 2 hours later because the "backoff"
    // never stopped knocking. Going quiet is what lets a block lift; the shops taught the same
    // lesson the same day.
    if (now < this._searchBlockedUntil) {
      const left = Math.round((this._searchBlockedUntil - now) / 1000);
      logger.warn(`Amazon: search quiet for another ${left}s (letting the block decay)`);
      for (const [asin, cached] of this._knownProducts) products[asin] = cached;
      return products;
    }

    await this._runDiscovery(products);

    // Prune anything unseen for 24h so a delisted ASIN does not linger forever
    for (const [asin, data] of this._knownProducts) {
      if (!(asin in products) && (now - (data.lastSeen || 0)) > 24 * 60 * 60 * 1000) {
        this._knownProducts.delete(asin);
      }
    }

    // Re-apply the scope test to the CACHE, not just to newly discovered cards. A cached
    // ASIN is re-checked every poll, and that re-check refreshes lastSeen, so the 24h prune
    // above can never reach it — an ASIN that should never have been tracked would alert
    // forever. This is what kept B0GX7S11S3 ("Psychedelic Universe", no franchise word)
    // firing the same price drop 21 times until the limiter muted the retailer.
    for (const [asin, data] of this._knownProducts) {
      if (!isInScopeName(data.name)) {
        logger.warn(`Amazon: dropping out-of-scope cached ASIN ${asin} — ${data.name}`);
        this._knownProducts.delete(asin);
        delete products[asin];
      }
    }

    // The in-memory drop above is not enough on its own: products already written to Redis
    // by earlier builds survive a restart and a redeploy. Right after this fix shipped,
    // Redis still held 371 Amazon products of which 75 were out of scope — Lorcana deck
    // boxes, storage cases, sponsored-ad slots, hobby books. They are inert (nothing polls
    // them, so they raise no events) but they pollute the catalogue and cross-retailer
    // matching, and they would diff strangely if discovery ever touched them again.
    // Cleared once per process rather than every poll, since it scans the retailer keyspace.
    if (!this._scopePurgeDone) {
      this._scopePurgeDone = true;
      this._purgeOutOfScopeState().catch(err =>
        logger.warn(`Amazon: out-of-scope state purge failed: ${err.message}`));
    }

    // Back off the enrichment sweep while search is struggling — they share a pool
    const searchRate = this._searchSuccessRate();
    if (now - this._lastAodSweepAt >= this.aodSweepIntervalMs && (searchRate ?? 1) >= 0.5) {
      this._lastAodSweepAt = now;
      await this._monitorKnownAsins(products);
    }

    return products;
  }

  /**
   * Discovery: free search for new products and their current stock.
   */
  async _runDiscovery(products) {
    // Rotate through the queries instead of firing all of them every poll.
    //
    // Four searches every 6 seconds is 0.67 req/sec sustained against one endpoint, and it is
    // what got this IP blocked: Amazon tolerated it for ~14 hours and then cut us off. One
    // query per poll is the same coverage at a quarter of the load — every query is refreshed
    // every 24s — and it arrives smoothly rather than in bursts of four, which is the same
    // thing that fixed the shops.
    //
    // Carrying forward _knownProducts (below) means the queries not run this cycle still
    // report their products; only the discovery of a brand-new listing waits for its turn.
    if (!this._rateLogged) { this._rateLogged = true; this._logSearchRate(); }

    const batch = [];
    for (let i = 0; i < QUERIES_PER_POLL && i < this.searchQueries.length; i++) {
      batch.push(this.searchQueries[this._queryCursor % this.searchQueries.length]);
      this._queryCursor = (this._queryCursor + 1) % this.searchQueries.length;
    }

    const results = await Promise.allSettled(
      batch.map(query => this._freeSearch(query).then(items => ({ query, items })))
    );

    let hits = 0;
    let found = 0;
    for (const result of results) {
      if (result.status === 'rejected') continue;
      const { items } = result.value;
      if (!items || items.length === 0) continue;
      hits++;
      found += items.length;
      for (const item of items) {
        const product = this._buildFromSearch(item, result.value.query);
        if (!product) continue;
        products[product.sku] = product;
        this._knownProducts.set(product.sku, product);
      }
    }

    // Carry forward anything this sweep did not surface — absence from a search page is
    // not evidence of going out of stock
    for (const [asin, cached] of this._knownProducts) {
      if (!(asin in products)) products[asin] = cached;
    }

    this._recordSearchResult(hits, batch.length);
    this.reportFreshness(hits, batch.length);

    // Every query in this batch failed — Amazon is refusing us. Climb the quiet ladder so the
    // block can actually decay. Any success resets it.
    if (hits === 0) {
      const rung = Math.min(this._searchStrikes, SEARCH_BACKOFF_MS.length - 1);
      this._searchStrikes += 1;
      this._searchBlockedUntil = Date.now() + SEARCH_BACKOFF_MS[rung];
      logger.warn(`Amazon: search blocked (strike ${this._searchStrikes}) — quiet for ${SEARCH_BACKOFF_MS[rung] / 1000}s`);
    } else if (this._searchStrikes > 0) {
      logger.info(`Amazon: search recovered after ${this._searchStrikes} strike(s)`);
      this._searchStrikes = 0;
      this._searchBlockedUntil = 0;
    }

    logger.info(`Amazon: SEARCH — ${hits}/${batch.length} queries (${batch.join(', ')}), ${found} results, ${this._knownProducts.size} known ASINs ($0)`);
  }

  /**
   * Free search against amazon.ca. The old path spent 5 ScraperAPI credits per query and
   * so could only run every 30 minutes, which meant a brand-new listing went unnoticed
   * for up to half an hour. Plain search returns ASIN, title, price and stock for ~40
   * products per query and is not gated, so this can run on every poll for nothing.
   */
  async _freeSearch(query) {
    const url = `https://www.amazon.ca/s?k=${encodeURIComponent(query)}&i=toys`;

    // Spread across this retailer's ISP exits, and never fall back to residential.
    //
    // Amazon's search limit is per ADDRESS: four queries every six seconds from Railway's
    // single IP (0.67 req/s) blocked it after ~14 hours, which is why this adapter dropped to
    // one query per poll. Rotating exits divides that rate by the pool, so coverage can widen
    // without the rate per address rising — the same lever that fixed Walmart search.
    //
    // The residential fallback is deliberately gone. A search page is ~1.4MB, residential is
    // billed per GB, and a fallback that only fires when things are already going badly is
    // exactly when it would run hardest: four queries every 10s through it is ~48GB/day. The
    // ISP exits are flat-rate, so there is nothing left worth paying for here. Direct remains
    // the last resort because it costs nothing and still works when no pool is configured.
    const isp = getIspProxyRoundRobin(this.id);
    if (isp) {
      const viaIsp = await this._searchOnce(url, isp.url);
      if (viaIsp) return viaIsp;
    }
    return this._searchOnce(url, null);
  }

  /**
   * Say out loud what rate this configuration runs at per exit.
   *
   * Amazon blocked Railway's address at 0.67 req/s after ~14 hours — slow enough that no
   * short test catches it, so the number has to be visible in the log rather than discovered
   * a day later as "SEARCH — 0/4 queries" with no explanation.
   */
  _logSearchRate() {
    const exits = ispPoolSize(this.id);
    const totalRps = QUERIES_PER_POLL / (this.intervalMs / 1000);
    const rotationS = Math.ceil(this.searchQueries.length / QUERIES_PER_POLL) * (this.intervalMs / 1000);
    const base = `Amazon: search — ${QUERIES_PER_POLL}/${this.searchQueries.length} queries per ` +
      `${Math.round(this.intervalMs / 1000)}s poll (full rotation ${rotationS}s)`;
    if (exits === 0) {
      logger.warn(`${base} over the direct IP alone = ${totalRps.toFixed(3)} req/s on ONE address ` +
        '— 0.67 req/s blocked it after ~14h');
      return;
    }
    logger.info(`${base} over ${exits} ISP exit(s) = ${(totalRps / exits).toFixed(3)} req/s per exit`);
  }

  async _searchOnce(url, proxyUrl) {
    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 12000,
        rawHeaders: true,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      if (!html || html.length < 50000) return null;
      if (/api-services-support|Type the characters|continue shopping/.test(html)) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }
      return this._parseSearchHtml(html);
    } catch {
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  _parseSearchHtml(html) {
    const cards = html.split('data-component-type="s-search-result"').slice(1);
    const out = [];
    for (const card of cards) {
      const asin = (card.match(/data-csa-c-item-id="amzn1\.asin\.([A-Z0-9]{10})"/) || [])[1];
      if (!asin) continue;
      // An all-digit "ASIN" is an ISBN — a book about the game, not sealed product.
      // 1604382643 ("Pokemon Deluxe Character Guide") alerted this way on 2026-09-05.
      if (/^\d{10}$/.test(asin)) continue;
      const ariaName = (card.match(/<h2[^>]*aria-label="([^"]{8,200})"/) || [])[1];
      if (!ariaName) continue;
      // Sponsored placements render inside the result grid and their aria-label carries the
      // ad markup verbatim, which is how "Sponsored Ad - Title: Star Wars: Unlimited..."
      // became an alert title. The slot is an ad for another product, not a search result.
      if (/^sponsored ad\b/i.test(ariaName.trim())) continue;
      let name = ariaName;
      // Amazon's aria-label drops an accented brand prefix, so "Pokémon TCG: Mega
      // Evolution—Pitch Black Elite Trainer Box" arrives as "TCG: Mega Evolution—Pitch Black
      // Elite Trainer Box". That is what produced the truncated alert titles, and it also
      // stripped the franchise word the category classifier relies on. The product image's
      // alt keeps the full title.
      //
      // Restored ONLY when the alt is our exact title with a short prefix in front. An alt
      // inside a card's slice can belong to a neighbouring sponsored product — observed:
      // aria "The World Game - Geography Card Game" alongside alt "9-Pocket Top Loader
      // Binder" — so anything that is not a strict prefix-extension is ignored. By
      // construction this can only prepend a few characters, never swap in another product.
      const altRaw = (card.match(/class="s-image"[^>]*alt="([^"]{8,250})"/) || [])[1];
      let altAccepted = '';
      if (altRaw) {
        const alt = decodeEntities(altRaw.trim());
        const bare = decodeEntities(ariaName.trim());
        const prefixLen = alt.length - bare.length;
        if (prefixLen > 0 && prefixLen <= 30 && alt.endsWith(bare)) {
          name = alt;
          altAccepted = alt;
        }
      }
      // Scope the price to the card's OWN price block. A card's slice routinely contains
      // prices belonging to other ASINs — sponsored placements and related-item strips render
      // inside the result grid — so taking the first a-offscreen in the slice read a
      // neighbour's price. It was worst on cards with no price of their own (a genuinely
      // unavailable item), where the parser would reach past the product entirely and invent
      // one: B0GW2DK37Q has no price on the card, and successive polls attributed $15.99,
      // $147.00, $39.95 and $24.69 to it, each from whichever neighbour happened to be next.
      // Verified against a live page: where a real price exists this agrees 27/27.
      const priceStr = (card.match(/data-cy="price-recipe"[\s\S]{0,1200}?a-offscreen">\$([\d,]+\.\d{2})/) || [])[1];
      const price = priceStr ? normalizePrice(priceStr) : null;
      // A search card only shows a price when the item is buyable
      const oos = /Currently unavailable|Temporarily out of stock/i.test(card);
      out.push({
        asin,
        name: decodeEntities(name.trim()),
        // The image alt, carried through so the game filter can see the FULL title:
        // Amazon's aria-label drops an accented brand prefix, turning "Pokémon TCG: X" into
        // "TCG: X" — a title with no franchise word in it. Without the alt, requiring the
        // game name in the title would throw away real Pokemon products.
        //
        // Only the VALIDATED alt is carried. The raw alt used to be stored here, which
        // handed the game filter the exact string the name logic above had just rejected as
        // belonging to a neighbouring card. That is how "Trading Card Game 5-Pack Wave 1 Box
        // | Psychedelic Universe" — no franchise word of its own — borrowed a neighbour's
        // "Pokemon" and alerted 21 times on 2026-09-05, tripping the alert limiter.
        _alt: altAccepted,
        price,
        inStock: !!price && !oos,
        image: (card.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com[^"]+)"/) || [])[1] || '',
      });
    }
    return out;
  }

  /**
   * Amazon truncates search titles and often drops the franchise word — "TCG: First
   * Partner Illustration Collection" is a Pokemon product with nothing in the name to
   * say so, and would classify as "other" and never alert. The query that returned it
   * is the reliable signal, so it supplies the category when the title cannot.
   */
  _buildFromSearch(item, query) {
    if (!item.name || !item.asin) return null;
    const lower = item.name.toLowerCase();
    if (ACCESSORY_KEYWORDS.some(k => lower.includes(k))) return null;
    if (PRINT_KEYWORDS.some(k => lower.includes(k))) return null;
    if (!isTCGProduct(item.name)) return null;

    // The product must actually be one of the games we track.
    //
    // This path used to accept ANY trading card game and merely blocklist five named ones
    // (yugioh, mtg, lorcana, digimon, dragon ball). A blocklist cannot keep up: an "Italian
    // Brainrot Trading Card Game" box matched isTCGProduct, was not on the list, and was
    // alerted on — then mislabelled 'pokemon' by the category fallback below.
    //
    // fetchProductPage, the watchlist path, has always required a tracked game name. These two
    // paths disagreeing is what let a meme card game into a Pokemon monitor.
    //
    // Checked against the image alt as well as the title, because Amazon's aria-label drops
    // accented brand prefixes — "Pokémon TCG: Mega Evolution" arrives as "TCG: Mega Evolution".
    // The alt keeps the full title, so real Pokemon products with truncated titles still pass.
    const haystack = `${item.name} ${item._alt || ''}`.toLowerCase();
    if (!GAME_NAMES.some(g => haystack.includes(g))) return null;

    const cached = this._knownProducts.get(item.asin) || {};
    const product = this.classify({
      ...cached,
      sku: item.asin,
      name: item.name,
      price: item.price ?? cached.price ?? 0,
      currency: 'CAD',
      url: `https://www.amazon.ca/dp/${item.asin}`,
      image: item.image || cached.image || '',
      inStock: item.inStock,
      canAddToCart: item.inStock,
      shipsToHome: true,
      lastSeen: Date.now(),
    });

    // Category from the product itself, falling back to the query only when the product really
    // does name a tracked game. Previously this defaulted to 'pokemon' for anything the
    // classifier could not place, which is how an Italian Brainrot card game ended up
    // labelled as Pokemon in an alert.
    if (product.category === 'other') {
      if (/one piece/.test(haystack)) product.category = 'onepiece';
      else if (/pokemon|pokémon/.test(haystack)) product.category = 'pokemon';
      else if (query) {
        product.category = /one piece/i.test(query) ? 'onepiece' : 'pokemon';
        product._categoryFromQuery = true;
      }
    }
    return product;
  }

  _recordSearchResult(hits, total) {
    if (!total) return;
    this._searchWindow.push(hits / total);
    if (this._searchWindow.length > 10) this._searchWindow.shift();
  }

  _searchSuccessRate() {
    if (this._searchWindow.length < 3) return null;
    return this._searchWindow.reduce((a, b) => a + b, 0) / this._searchWindow.length;
  }

  /**
   * Monitor: check known ASINs via the AOD offer endpoint (FREE).
   * Returns cached data for ASINs where the fetch fails (prevents false OOS).
   */
  async _monitorKnownAsins(products) {
    const asins = [...this._knownProducts.keys()];
    if (asins.length === 0) {
      logger.debug('Amazon: no known ASINs — waiting for discovery');
      return;
    }

    // AOD is cheap per request but Amazon throttles it per-endpoint: 12 ASINs in ~7s
    // earned a 503 redirect to /error/500 on every call, direct and proxied alike.
    // Pairs with a wide gap keep the same 2-minute cadence well inside the limit.
    if (Date.now() < this._aodCooldownUntil) {
      const waitSec = Math.round((this._aodCooldownUntil - Date.now()) / 1000);
      logger.warn(`Amazon: MONITOR skipped — AOD throttled, retrying in ${waitSec}s`);
      for (const [asin, cached] of this._knownProducts) products[asin] = cached;
      return;
    }

    // Measured ceiling: sequential at ~0.5 req/s passes (5/5), two concurrent at ~1.3 req/s
    // fails (7/8 x 503) — and a fresh residential IP per request does not change that, so
    // the throttle is endpoint-wide rather than per-IP. One at a time it is.
    let checked = 0;
    let updated = 0;
    let throttled = 0;
    const BATCH = 1;

    for (let i = 0; i < asins.length; i += BATCH) {
      const batch = asins.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(asin => this._stealthCheckAsin(asin).then(data => ({ asin, data })))
      );

      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { asin, data } = result.value;
        checked++;

        if (data) {
          updated++;
          const cached = this._knownProducts.get(asin);

          // AOD hands us the offer listing id and seller for free. Caching them here is
          // what stops delivery.enrichEvent paying 10 ScraperAPI credits per alert.
          if (data.olid || data.seller) {
            state.cacheOfferListingId(asin, data.olid).catch(() => {});
            if (data.seller) state.cacheSellerInfo(asin, data.seller).catch(() => {});
          }

          // AOD returns the LIVE title for this exact ASIN on every poll, and this path used
          // to discard it and keep whatever name discovery first stored. Amazon repurposes
          // listings, so a frozen name eventually describes a different product than the one
          // the link goes to: on 2026-09-08 ASIN B0BCC6N8YL alerted as "Pokemon TCG: Mega
          // Evolution - Chaos Rising Sleeved Booster" while /dp/B0BCC6N8YL served a
          // PopSockets phone grip. Name, image and link disagreed, and nothing could notice
          // because the only name anyone read was the stale one — including the out-of-scope
          // purge in fetchProducts, which rejects that live title (verified) but was reading
          // the cached name too.
          //
          // Checked against the shared scope rule, not a bespoke test, so an ASIN that stops
          // being a product we track leaves the same way any other out-of-scope product does.
          if (data.name && !isInScopeName(data.name)) {
            logger.warn(`Amazon: ASIN ${asin} is no longer the product we stored — dropping. Was "${cached?.name}", now "${data.name}"`);
            this._knownProducts.delete(asin);
            delete products[asin];
            continue;
          }

          // Still in scope, but a relist can swap one tracked product for another — and a
          // wrong name on a real alert is worse than no alert. Adopt the live title when it
          // is not simply a fuller rendering of the cached one. Amazon's search aria-label
          // drops accented brand prefixes ("Pokémon TCG: X" arrives as "TCG: X"), so the
          // cached name is normally a substring of the AOD title; only a break in that
          // containment means the listing actually became something else.
          let name = cached?.name;
          let category = cached?.category;
          if (data.name && cached?.name && !sameProductName(cached.name, data.name)) {
            logger.warn(`Amazon: ASIN ${asin} was relisted — "${cached.name}" -> "${data.name}"`);
            name = data.name;
            // Re-place it, but keep the discovered category when the new title names only a
            // set: isInScopeName accepts a set name as evidence, and classifyCategory does
            // not, so re-classifying blind would turn a real Pokemon product into 'other'.
            const reclassified = this.classify({ name: data.name }).category;
            if (reclassified !== 'other') category = reclassified;
          }

          // Keep cached identity (category, retailer) — update name, price + stock
          const product = {
            ...cached,
            name: name || cached?.name,
            category: category || cached?.category,
            price: data.price || cached.price,
            inStock: data.inStock,
            canAddToCart: data.inStock,
            image: data.image || cached.image,
            lastSeen: Date.now(),
          };
          this._knownProducts.set(asin, product);
          products[asin] = product;
        } else {
          // Fetch failed — return cached data unchanged (no false OOS events)
          if (this._lastFetchThrottled) throttled++;
          const cached = this._knownProducts.get(asin);
          if (cached) products[asin] = cached;
        }
      }

      // Back off the whole pass as soon as Amazon starts throttling, rather than
      // walking the rest of the list into the same wall
      if (throttled >= 2) {
        this._aodCooldownUntil = Date.now() + AOD_COOLDOWN_MS;
        logger.warn(`Amazon: AOD throttled (${throttled} x 503) — pausing the monitor for ${AOD_COOLDOWN_MS / 60000}min`);
        for (const [asin, cached] of this._knownProducts) {
          if (!(asin in products)) products[asin] = cached;
        }
        break;
      }

      if (i + BATCH < asins.length) {
        const px = getProxyUrl('residential');
        if (px) _clearCache(px);
        await sleep(1600 + Math.floor(Math.random() * 600));
      }
    }

    this.reportFreshness(updated, checked);
    this._monitorSuccessRate = checked > 0 ? Math.round((updated / checked) * 100) : 0;
    logger.info(`Amazon: MONITOR — ${updated}/${checked} ASINs updated (free stealth). ${this._monitorSuccessRate}% success.${throttled ? ` ${throttled} throttled.` : ''}`);
  }

  /**
   * Fetch a single product page — used by watchlist fast-polling.
   */
  async fetchProductPage(asin) {
    const data = await this._stealthCheckAsin(asin);
    if (!data) return null;

    // Apply game name + TCG filters
    const lowerName = data.name.toLowerCase();
    const hasGameName = GAME_NAMES.some(g => lowerName.includes(g));
    if (!hasGameName) return null;
    if (!isTCGProduct(data.name)) return null;

    return this.classify({
      sku: asin,
      name: data.name,
      price: data.price,
      currency: 'CAD',
      url: `https://www.amazon.ca/dp/${asin}`,
      image: data.image || '',
      inStock: data.inStock,
      canAddToCart: data.inStock,
      shipsToHome: true,
    });
  }

  /**
   * Process search result items into classified products.
   * Used by discovery (ScraperAPI JSON results).
   * Applies all 5 filter layers: game name, TCG product, accessory, seller, price.
   */
  _processSearchItems(items, products) {
    for (const item of items) {
      try {
        const asin = item.asin || item.ASIN;
        if (!asin) continue;

        const name = item.name || item.title;
        if (!name) continue;

        const lowerName = name.toLowerCase();

        // Layer 1: Must mention a game we actually track
        const hasGameName = GAME_NAMES.some(g => lowerName.includes(g));
        if (!hasGameName) continue;

        // Layer 2: Must pass shared TCG product filter (sealed products, not figures/toys)
        if (!isTCGProduct(name)) continue;

        // Layer 3: Exclude accessories (deck boxes, binders, sleeves, etc.)
        const isAccessory = ACCESSORY_KEYWORDS.some(kw => lowerName.includes(kw));
        if (isAccessory) continue;

        // Layer 4: emi= URL filter restricts to "sold by Amazon.ca" at search level.
        // Double-check if seller data is present.
        const seller = (item.sold_by || item.seller || '').toLowerCase();
        if (seller && !seller.includes('amazon')) continue;

        const price = typeof item.price === 'number' ? item.price :
          normalizePrice(item.price_string || item.price || item.current_price);

        // Layer 5: Must have a real price
        if (price == null || price <= 0) continue;

        const url = item.url || item.product_url || item.link ||
          `https://www.amazon.ca/dp/${asin}`;
        const fullUrl = url.startsWith('http') ? url : `https://www.amazon.ca${url}`;

        const image = item.image || item.thumbnail || '';
        const inStock = true;

        const product = this.classify({
          sku: asin,
          name,
          price,
          currency: 'CAD',
          url: fullUrl,
          image,
          inStock,
          canAddToCart: inStock,
          shipsToHome: true,
        });

        products[product.sku] = product;
      } catch (err) {
        logger.debug(`Amazon: failed to parse item: ${err.message}`);
      }
    }
  }
}

module.exports = AmazonAdapter;
