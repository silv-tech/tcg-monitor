const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, isTCGProduct, sleep } = require('../utils/helpers');
const { getProxyUrl, getIspProxyRoundRobin, ispPoolSize } = require('../core/proxy');

const { stealthGet, _clearCache } = require('../utils/stealth-http');
const state = require('../core/state');
const rateBudget = require('../utils/rate-budget');
const { fetchAmazonOffers } = require('../utils/scraper-api');
const { searchQueries: BASE_QUERIES, setQueries: SET_QUERIES } = require('../config/products.json');
const SEARCH_QUERIES = [...BASE_QUERIES, ...(SET_QUERIES || [])];

// Game names that we track — Amazon results MUST match one of these.
// Scoped to Pokemon and One Piece to match every other adapter.
// One shared scope rule across every retailer — see src/utils/scope.js. It used to live
// here, which is exactly why Walmart never had one.
const {
  GAME_NAMES,
  SET_NAMES,
  ACCESSORY_KEYWORDS,
  PRINT_KEYWORDS,
  isInScopeName,
} = require('../utils/scope');

// Game scope for the discovery paths: a franchise word OR a known set name. Amazon's search
// tiles drop the accented "Pokémon" prefix ("Pokémon TCG: 30th Celebration ETB" -> "TCG: 30th
// Celebration ETB"), so requiring GAME_NAMES alone silently dropped whole product lines whose
// set name we DO recognise (this is why the 30th-anniversary items were missed). Mirrors the
// canonical isInScopeName game-name gate so discovery agrees with the cache/relist checks.
function hasGameScope(lowerText) {
  return GAME_NAMES.some(g => lowerText.includes(g)) || SET_NAMES.some(k => lowerText.includes(k));
}

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

// Some items are buyable on Amazon but carry NO price on the search tile (verified on
// B0GW2DK37Q — "First Partner Illustration Collection Series 2" — listed in stock, priced only
// on its own product page). Our search stores price 0 for those, and delivery's no-price filter
// then drops the alert, so a genuine restock is missed while a competitor that reads the product
// page catches it. When we see a buyable-but-priceless item, resolve its price from the product
// page (AOD fragment, ~30KB residential, no ScraperAPI credit) so the alert can go out. Bounded
// per poll because each is a page fetch, and cached once resolved so it is never re-fetched.
const MAX_PRICE_FILL_PER_POLL = Number(process.env.AMAZON_MAX_PRICE_FILL_PER_POLL) || 3;

// Batch-ASIN stock sweep — the FREE replacement for the per-ASIN AOD checker (which Amazon blocks).
// Amazon's /s search accepts pipe-joined ASINs (k=B0AAA|B0BBB — its OR operator) and returns a
// normal results grid, so we can stock-check EVERY tracked ASIN by exact id, over the SAME endpoint
// and ISP pool as keyword search, for nothing. This is the leg that catches a restock on a page-2-
// ranked item like B0H78BB9TY (30th Celebration ETB) that keyword relevance never surfaces and AOD
// can no longer check. Paced by a persistent cursor (a few chunks per poll, NOT a per-poll burst)
// so total /s request volume stays near-flat and can never re-block search — our only live leg.
// REVERT: set AMAZON_ASIN_SWEEP=0 in the Railway env to disable it instantly (no code change).
const ASIN_SWEEP_ENABLED = process.env.AMAZON_ASIN_SWEEP !== '0';
const ASIN_BATCH_SIZE = Number(process.env.AMAZON_ASIN_BATCH_SIZE) || 20;      // ASINs per /s request
const ASIN_BATCHES_PER_POLL = Number(process.env.AMAZON_ASIN_BATCHES_PER_POLL) || 1; // +N /s req/poll

// Offers lane — the GUARANTEED per-ASIN stock check for "search-invisible" ASINs. Amazon serves no
// search tile for an item with no live offer, so an OOS-and-suppressed ASIN (e.g. B0H78BB9TY, the
// 30th Celebration ETB) is never returned by the free batch sweep — it just sits correctly OOS, and
// its restock has no tile to appear in. ScraperAPI's structured/amazon/offers (~1 credit) returns a
// definitive stock verdict tile-or-no-tile, so this lane fires the false->true RESTOCK the sweep
// cannot. Paced to one paid call per interval and hard-capped per day so it never eats the budget.
// REVERT: AMAZON_OFFERS_LANE=0. An ASIN is "invisible" once the sweep hasn't refreshed it in STALE_MS.
const OFFERS_LANE_ENABLED = process.env.AMAZON_OFFERS_LANE !== '0';
const OFFERS_INTERVAL_MS = Number(process.env.AMAZON_OFFERS_INTERVAL_MS) || 20000; // ≥1 paid call/20s
const OFFERS_STALE_MS = Number(process.env.AMAZON_OFFERS_STALE_MS) || 10 * 60 * 1000; // sweep-missed
const OFFERS_DAILY_CAP = Number(process.env.AMAZON_OFFERS_DAILY_CAP) || 4000; // ScraperAPI credits/day

const DISCOVERY_INTERVAL_DEFAULT = 30 * 60 * 1000;
const DISCOVERY_INTERVAL_FLOOR = 5 * 60 * 1000;
// Escalating quiet ladder for a throttled AOD endpoint, mirroring the search backoff ladder. A
// FLAT cooldown didn't clear a stubborn block: each 10-min window ended with a retry poke, and a
// block only decays under sustained silence (the search incident: a lightly-poked block stayed
// dead 2h+, a quiet one lifted in ~23min). Each consecutive block waits longer; a successful read
// resets to the bottom. So a one-off throttle costs 10min, a hard block escalates to real silence.
const AOD_COOLDOWN_LADDER_MS = [10 * 60 * 1000, 20 * 60 * 1000, 40 * 60 * 1000];
const AOD_THROTTLE_STRIKES = 2;   // consecutive 503s (any lane) before every AOD lane goes quiet

// ONE shared budget for EVERY AOD call — the sweep, the watchlist fast-poll, and the price-fill
// all hit the same endpoint, which Amazon throttles endpoint-wide (measured: sequential ~0.5
// req/s passes, two concurrent 503s on every call, and a fresh IP per request does NOT help). The
// two loops were previously uncoordinated: fine at 3 watchlist ASINs, but scaling the fast lane
// would let their combined rate trip the 10-min cooldown that stalls BOTH lanes — exactly the
// kind of self-inflicted outage this monitor has hit before. A single token bucket at burst 1
// makes AOD strictly one-at-a-time and mathematically incapable of exceeding the ceiling, no
// matter how the loops interleave. A budget MISS is not an endpoint throttle: the caller returns
// null (kept as cached, no false OOS) and never enters the cooldown.
const AOD_BUDGET_KEY = 'amazon:aod';
const AOD_RATE_PER_SEC = 0.45;   // just under the measured ~0.5 req/s sequential ceiling
const AOD_ACQUIRE_WAIT_MS = 6000; // small, so a 120s-timeout-orphaned poll cannot pile up waiters

// Restock detection was a flat, unprioritised round-robin over every known ASIN (~1.9s each →
// ~19min per lap, growing with the catalogue): far too slow against items that restock every
// ~20min. "Hot" = seen in stock within HOT_WINDOW_MS; the HOT_MAX most-recently-in-stock get the
// fast AOD lane (priority 0), the rest stay on the slow sweep (priority 1). Auto-detected — no
// hand-curation — so an item earns the fast lane by actually restocking. Cap keeps the fast
// lane's share of the shared budget bounded (10 items / ~25s ≈ 0.4 req/s, well under the ceiling).
const HOT_WINDOW_MS = 48 * 60 * 60 * 1000;
const HOT_MAX = 10;

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    this._knownProducts = new Map(); // ASIN → classified product (persists between polls)
    this._hydrated = false;          // catalogue reloaded from Redis once per process
    this._denied = new Set();        // ASINs proven to serve a different product now
    this._lastDiscoveryAt = 0;       // timestamp of last ScraperAPI discovery
    this._monitorSuccessRate = 0;    // track product page stealth success %
    this.watchlist = new Set(config.watchlist || []); // fast-polled by the scheduler
    this._aodCooldownUntil = 0;      // set when Amazon starts 503ing the offer endpoint
    this._aodThrottleStreak = 0;     // consecutive AOD 503s across ALL lanes; trips the shared cooldown
    this._aodCooldownLevel = 0;      // rung on the escalating cooldown ladder; reset by a real read
    this._aodCursor = 0;             // persistent round-robin position for the known-ASIN sweep,
                                     // so a throttle-break resumes the tail instead of restarting
                                     // at 0 and starving late ASINs (that is why a tracked ASIN's
                                     // restock — B0H78BB9TY — was never AOD-checked and missed)
    this._lastFetchThrottled = false;
    this._searchWindow = [];         // rolling free-search success
    this._searchSkip = 0;
    this._queryCursor = 0;
    this._newestCursor = 0;   // independent walk for the newest-first probe
    this._asinSweepCursor = 0; // persistent walk over catalogue chunks for the batch-ASIN sweep
    this._lastOffersAt = 0;    // paces the offers lane's paid calls
    this._offersDay = null;    // YYYY-MM-DD of the current offers daily-cap window
    this._offersToday = 0;     // paid offers calls spent today (hard cap)
    this._searchStrikes = 0;
    this._searchBlockedUntil = 0;
    this._lastAodSweepAt = 0;
    this._sweepInFlight = false;     // single-flight guard: the 120s poll timeout orphans (does not
                                     // cancel) a long sweep, so a fresh poll could start a second
                                     // one that races the first over _aodCursor/_knownProducts
    this._lastInStockAt = new Map(); // ASIN → last time seen in stock, drives the auto-hot fast lane
    // SKUs whose stored row is a GUESS written before the withhold fix — see _findGuessedRows.
    this._seedSkus = new Set();
    // ASINs we have WITHHELD at least once. A withheld item has no stored row, so its first
    // publication looks like a brand-new listing and fires NEW_SKU — the RESTOCK flood traded
    // for an identically-sized NEW_SKU flood. It is not new to Amazon; it is new to us, and
    // only because we could not price it. Seeded on first publish, then alerts normally.
    this._withheldSkus = new Set();
    this._guessScanDone = false;
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
  async _stealthCheckAsin(asin, priority = 1, ctx = null) {
    // Every AOD request in the process passes through here, so this is the one place the shared
    // endpoint budget can be enforced. burst 1 = one grant at a time. priority 0 = latency-
    // critical (watchlist/hot); 1 = background (sweep, price-fill) so it yields to the hot lane.
    //
    // Throttle signalling: `this._lastFetchThrottled` is a shared field kept only for the
    // price-fill pre-gate (a non-critical heuristic). The COOLDOWN decision must not read it —
    // concurrent lanes clobber it — so we also record the throttle on the caller's private `ctx`,
    // which the sweep reads per-call and cannot be corrupted by a sibling lane.
    const mark = (v) => { this._lastFetchThrottled = v; if (ctx) ctx.throttled = v; };

    // Go quiet on the shared cooldown — EVERY AOD lane, not just the sweep. An endpoint-wide block
    // only decays when we STOP hitting it; the hot lane and price-fill used to keep knocking through
    // the cooldown (fetchProductPage never checked it) and held the block open — the search-quiet
    // ladder learned this same lesson. A cooldown skip is not a throttle: mark(false), keep the cache.
    if (Date.now() < this._aodCooldownUntil) { mark(false); return null; }

    // A miss means "out of budget", NOT "endpoint throttled": mark false so the sweep never
    // counts it toward the 2-strike cooldown, and return null so callers keep the cached row.
    const granted = await rateBudget.acquire(AOD_BUDGET_KEY, AOD_ACQUIRE_WAIT_MS, priority,
      { ratePerSec: AOD_RATE_PER_SEC, burst: 1 });
    if (!granted) { mark(false); return null; }

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

      mark(false);
      // Amazon answers an over-used AOD endpoint with a 503 that redirects to /error/500
      if (html && html.includes('/error/500')) {
        mark(true);
        this._aodStrike();
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

      this._aodRecovered(); // a real buy-box read: endpoint healthy, reset strike counter + ladder
      return this._parseAod(html, asin);
    } catch (err) {
      // stealthGet throws on 503 before we can read the body
      const throttled = /50[03]|Blocked after/.test(err.message || '');
      mark(throttled);
      if (throttled) this._aodStrike();
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  /**
   * Count a 503 from ANY AOD lane and, at the strike threshold, pause every lane for the cooldown.
   *
   * Centralised here (not just in the sweep) so the hot/watchlist lane and price-fill can BOTH trip
   * and observe the block — otherwise, when the block began between sweeps, the hot lane kept
   * knocking for up to a full sweep interval and stopped the endpoint from ever decaying.
   */
  // A real AOD read succeeded: the endpoint is healthy, so drop back to the shortest cooldown.
  _aodRecovered() {
    this._aodThrottleStreak = 0;
    this._aodCooldownLevel = 0;
  }

  _aodStrike() {
    // Already paused this window: an in-flight 503 that lands after the cooldown was armed must not
    // re-count. Several lanes can 503 near-simultaneously, and without this a single outage could
    // climb the ladder more than once (skipping rungs). Re-blocks AFTER a window expires still climb.
    if (Date.now() < this._aodCooldownUntil) return;
    if (++this._aodThrottleStreak >= AOD_THROTTLE_STRIKES) {
      // Climb the ladder: each consecutive block (no success in between) waits longer, so a
      // stubborn block gets real uninterrupted silence instead of a poke every 10 min.
      const wait = AOD_COOLDOWN_LADDER_MS[Math.min(this._aodCooldownLevel, AOD_COOLDOWN_LADDER_MS.length - 1)];
      this._aodCooldownUntil = Date.now() + wait;
      this._aodCooldownLevel += 1;
      this._aodThrottleStreak = 0;
      logger.warn(`Amazon: AOD throttled (${AOD_THROTTLE_STRIKES}x 503) — pausing ALL AOD lanes for `
        + `${wait / 60000}min (block level ${this._aodCooldownLevel}) so the block can decay`);
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
  /**
   * Reload the catalogue from Redis once per process.
   *
   * Without this, every restart is a false-RESTOCK storm. `_knownProducts` is in-memory only, so
   * a cold start reports a handful of products while Redis still holds hundreds; poll-adapter's
   * stale cleanup concludes the rest were delisted and writes inStock:false across the
   * catalogue, and the next poll — finding them again on the same search pages — fires RESTOCK
   * for every one. Its only guard is `newCount < oldCount * 0.3`, and a warming cache crosses
   * that long before the query cursor has been round the 13 queries.
   *
   * Measured on the 2026-09-09 17:04 deploy: 322 rows written out of stock at 17:04:47, 37
   * events seven seconds later, the limiter muted Amazon at 17:04:54 having spent all three
   * restock escapes in the SAME MILLISECOND, and the mute then ran for its full ten minutes.
   * The stale counter decayed 285 -> 208 as each falsely-dead product was rediscovered: 77
   * recoveries against 75 suppressed + 3 escaped. Every deploy reproduced it, and deploys
   * cluster exactly when someone is chasing a drop.
   *
   * Shopify (_loadHandleIndex) and EB Games already do this; Amazon was the only large adapter
   * that did not. Scope is re-applied on the way in, because Redis holds rows written by older
   * builds under older rules.
   */
  /**
   * Record that an ASIN no longer holds the product we stored.
   *
   * Fire-and-forget: the in-memory set is what the next poll reads, and a Redis hiccup must not
   * take down a poll. The persisted copy is what survives a restart, so the guard does not have
   * to re-discover the same drift after every deploy.
   */
  _denyIdentity(sku, liveTitle) {
    this._denied.add(sku);
    state.denyIdentity(this.id, sku, liveTitle).catch((err) =>
      logger.warn(`Amazon: could not persist identity denial for ${sku}: ${err.message}`));
  }

  async _hydrateFromRedis() {
    if (this._hydrated) return;
    this._hydrated = true;
    try {
      // Bounded: a slow Redis must delay the first poll, never hang it.
      // The timer is cleared explicitly. An uncleared 5s timer is a live handle, and in a test
      // runner a live handle keeps the whole process alive after the assertions pass.
      let timer;
      const cached = await Promise.race([
        state.getAllProducts(this.id),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), 5000); }),
      ]).finally(() => clearTimeout(timer));

      // Load the proven-wrong set FIRST, so a denied ASIN is never hydrated back in. Its stored
      // name is the stale in-scope one, so isInScopeName below cannot recognise it.
      try {
        const denied = await state.getDeniedIdentities(this.id);
        for (const sku of denied.keys()) this._denied.add(sku);
        if (this._denied.size) logger.info(`${this.name}: ${this._denied.size} ASIN(s) on the identity denylist`);
      } catch (err) {
        logger.warn(`${this.name}: could not load the identity denylist: ${err.message}`);
      }

      let loaded = 0;
      let outOfScope = 0;
      let denied = 0;
      for (const [asin, product] of Object.entries(cached || {})) {
        if (!product || !product.name) continue;
        if (this._denied.has(asin)) { denied++; continue; }
        if (!isInScopeName(product.name)) { outOfScope++; continue; }
        if (this._knownProducts.has(asin)) continue;
        this._knownProducts.set(asin, product);
        loaded++;
      }
      logger.info(`${this.name}: hydrated ${loaded} products from Redis`
        + `${outOfScope ? ` (${outOfScope} out of scope, skipped)` : ''}`
        + `${denied ? ` (${denied} on the identity denylist, skipped)` : ''}`);
    } catch (err) {
      // Degraded, not broken: the catalogue rebuilds as the query cursor rotates. Say it loudly,
      // because this is precisely the condition that produces the restart flood.
      logger.warn(`${this.name}: catalogue hydration failed (${err.message}) — cold start, `
        + 'stale cleanup may fire spuriously this cycle');
    }
  }

  async _collectProducts() {
    const products = {};
    const now = Date.now();

    // Before anything else, and before the search-blocked early return below — a cold cache is
    // what turns a restart into a flood, and that is true whether or not search is available.
    await this._hydrateFromRedis();

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
      // A watchlist ASIN is the user's explicit pick and is never scope-dropped — the same guard
      // poll-adapter and base use. It matters here because fetchProductPage now seeds config
      // items into _knownProducts (so the main poll and the fast loop agree); its admit gate
      // (hasGameScope + isTCGProduct) is looser than isInScopeName, so without this a watchlist
      // item whose live title reads as merch/accessory would be deleted and re-added every poll.
      if (this.watchlist.has(asin)) continue;
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

    if (!this._guessScanDone) {
      this._guessScanDone = true;
      this._findGuessedRows().catch(err =>
        logger.warn(`Amazon: guessed-row scan failed: ${err.message}`));
    }

    // The AOD known-ASIN sweep is our ONLY reliable restock detector for tracked products, and
    // it uses a different endpoint (AOD) over a different pool (residential-us) than search (ISP
    // exits). It was previously skipped whenever SEARCH looked unhealthy — which blinded restock
    // detection during a search block for no reason, since the two do not share a pool. Gate it
    // only on its own cadence and its own AOD cooldown (handled inside _monitorKnownAsins).
    if (now - this._lastAodSweepAt >= this.aodSweepIntervalMs) {
      this._lastAodSweepAt = now;
      await this._monitorKnownAsins(products);
    }

    return products;
  }

  /**
   * The fast-poll (hot) lane the scheduler's watchlist loop drives. Config watchlist ASINs are
   * always included — they are unindexed, so search can never rediscover them, and dropping them
   * would risk the one miss we most want to avoid. On top of that, the HOT_MAX most-recently-in-
   * stock ASINs (seen within HOT_WINDOW_MS) earn the lane automatically. Everything else stays on
   * the slow sweep. The scheduler prefers this over the static `watchlist` when present.
   */
  getFastPollAsins() {
    const now = Date.now();
    const hot = [];
    for (const [asin, ts] of this._lastInStockAt) {
      if (now - ts < HOT_WINDOW_MS) hot.push(asin);
    }
    hot.sort((a, b) => this._lastInStockAt.get(b) - this._lastInStockAt.get(a)); // freshest first
    const set = new Set(this.watchlist);
    for (const asin of hot) {
      if (set.size >= HOT_MAX) break;
      set.add(asin);
    }
    return set;
  }

  /**
   * Never report a product whose stock we have not actually established.
   *
   * A tile with no price says nothing about availability, and a price-fill that has not run yet
   * (bounded per poll) or that failed says nothing either. Publishing those as "out of stock"
   * writes a GUESS into Redis — and the moment a later fill resolves it, the diff sees
   * false -> true and fires a RESTOCK for an item that never went anywhere. On 2026-09-09 that
   * flooded the channel three times and muted the retailer for ten minutes each time,
   * suppressing genuine alerts along with the noise.
   *
   * This is a WRAPPER, not a step at the end of the poll, because the first version was a step
   * at the end and the search-backoff early return jumped straight past it — dumping the raw
   * _knownProducts map, guesses and all, on every poll for the 60-900s a backoff lasts. With
   * one query per poll a single failed exit is enough to enter that state, so the hole was hit
   * often. A wrapper covers every return path, including ones added later.
   *
   * Withholding is strictly safer than guessing: an unresolved item is simply not reported
   * until AOD reads a real buy box. It stays in _knownProducts and is retried every poll.
   */
  async fetchProducts() {
    const products = await this._collectProducts();
    for (const [sku, p] of Object.entries(products)) {
      if (p && p._priceUnknown && !(p.price > 0)) {
        this._withheldSkus.add(sku);
        delete products[sku];
      }
    }
    // A withheld item that has now resolved is not a new listing — seed it, do not announce it.
    for (const sku of this._withheldSkus) {
      if (sku in products) { this._withheldSkus.delete(sku); this._seedSkus.add(sku); }
    }
    await this._seedRepairedRows(products);
    return products;
  }

  /**
   * Find the false out-of-stock rows written before the withhold fix, once per process.
   *
   * Between widening the query list and fixing the leak, every unresolved tile was published as
   * inStock:false with no price — a guess with nothing behind it. Those rows are still in Redis
   * and poll-adapter's stale cleanup re-pins them with a fresh TTL on every poll, so they never
   * expire. Each one is a loaded RESTOCK: the moment AOD reads a real buy box the diff sees
   * false -> true and alerts for a product that never went anywhere.
   *
   * Nothing is deleted. A row is only marked, and _seedRepairedRows overwrites it with the truth
   * the first time we actually know it — deleting instead would just turn the RESTOCK flood into
   * an identically-sized NEW_SKU flood.
   */
  async _findGuessedRows() {
    const all = await state.getAllProducts(this.id);
    const entries = Object.entries(all || {});
    if (entries.length === 0) return;

    const watched = this.watchlist instanceof Set ? this.watchlist : new Set();
    const guesses = entries.filter(([sku, p]) => p
      && p.inStock === false && !(p.price > 0)
      && !watched.has(String(sku)) && !p._watchlist);
    if (guesses.length === 0) return;

    for (const [sku] of guesses) this._seedSkus.add(String(sku));
    logger.info(`Amazon: ${guesses.length}/${entries.length} stored rows are unpriced `
      + 'out-of-stock guesses — re-baselining them silently instead of alerting on the correction');
  }

  /**
   * Overwrite a guessed row with the truth BEFORE the diff reads it, so the correction is
   * silent. poll-adapter reads oldProducts after fetchProducts returns, so a row written here is
   * what the diff compares against — identical to what we publish, therefore no event.
   *
   * A genuine restock of one of these loses exactly one alert, and only once: the row said
   * price 0, and delivery drops price-0 alerts anyway, so nothing that could have reached a
   * customer is lost. Every later change alerts normally.
   */
  async _seedRepairedRows(products) {
    if (this._seedSkus.size === 0) return;
    for (const [sku, p] of Object.entries(products)) {
      if (!this._seedSkus.has(sku)) continue;
      this._seedSkus.delete(sku);
      await state.setProduct(this.id, sku, p).catch(err =>
        logger.warn(`Amazon: could not re-baseline ${sku}: ${err.message}`));
      logger.debug(`Amazon: re-baselined ${sku} at $${p.price} inStock=${p.inStock} (no alert)`);
    }
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

    // Relevance queries walk a list of (query, page) pairs — every query at page 1 AND page 2 —
    // so a product ranked below the page-1 fold is still seen (B0H7818RCM sat at relevance rank
    // ~25/83, on page 2, and was structurally invisible when we only ever read page 1). The
    // cursor cycles all 2×queries pairs, so requests/poll are UNCHANGED — same count, same
    // per-exit rate — depth just doubles over two passes of the list. Rate-neutral by design.
    const qp = this.searchQueries.length * 2; // each query contributes a page-1 and a page-2 slot
    const batch = [];
    for (let i = 0; i < QUERIES_PER_POLL && i < qp; i++) {
      const idx = this._queryCursor % qp;
      batch.push({
        query: this.searchQueries[idx % this.searchQueries.length],
        newest: false,
        page: 1 + Math.floor(idx / this.searchQueries.length), // first pass = page 1, second = page 2
      });
      this._queryCursor = (this._queryCursor + 1) % qp;
    }

    // One extra probe per poll, newest-first, walking the query list on its own cursor. This is
    // the only path that sees a listing before it earns relevance ranking, and it costs one
    // request: at four queries over eight exits that is 0.083 -> 0.104 req/s per exit, still
    // six times under the rate that blocked this IP.
    if (this.searchQueries.length > 0) {
      // Newest-first probe stays on page 1: its whole value is the freshest listings, which are
      // at the top of the date-desc sort — page 2 of "newest" is just older items already seen.
      batch.push({ query: this.searchQueries[this._newestCursor % this.searchQueries.length], newest: true, page: 1 });
      this._newestCursor = (this._newestCursor + 1) % this.searchQueries.length;
    }

    const results = await Promise.allSettled(
      batch.map(({ query, newest, page }) => this._freeSearch(query, newest, page).then(items => ({ query, items })))
    );

    let hits = 0;
    let found = 0;
    // Buyable items whose search tile carried no price — keyed by ASIN so the same product
    // surfacing under several queries is only looked up once.
    const priceless = new Map();
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
        // In stock but no price we can trust: delivery would silently drop the alert. Queue a
        // product-page price lookup so a real restock is not lost for want of a price.
        // Ambiguous tile: no price shown and no "Currently unavailable". Once a price has
        // been resolved and cached, _buildFromSearch reuses it, so this stops queueing.
        if (product._priceUnknown && !(product.price > 0)) priceless.set(product.sku, product);
      }
    }

    // Resolve prices for the buyable-but-priceless items from their own product page. Bounded
    // per poll (each is a residential AOD fetch), skipped entirely while AOD is throttling, and
    // done in parallel to keep the poll fast. A resolved price is written back to _knownProducts,
    // so from the next poll _buildFromSearch reuses it and the item is never queued again. A
    // lookup that yields no price leaves the item at 0 — suppressed exactly as before, then
    // retried the next time it is seen: a miss becomes an alert, never a wrong price.
    if (priceless.size && !this._lastFetchThrottled) {
      const toFill = [...priceless.values()].slice(0, MAX_PRICE_FILL_PER_POLL);
      // Sequential, not Promise.all: AOD 503s on concurrent requests (measured: two at once →
      // 7/8 fail). The shared budget already paces grants, but issuing these one-by-one keeps a
      // single AOD connection in flight rather than up to three.
      for (const product of toFill) {
        try {
          const data = await this._stealthCheckAsin(product.sku);

          // Check WHAT we are filling before filling it.
          //
          // AOD returns the live title in the same response this already parses, and this path
          // threw it away — it adopted a price and could raise inStock without ever asking
          // whether the ASIN still holds the product we stored. Amazon repurposes listings:
          // B0D2JGYX3F alerted as "Pokémon TCG: Gardevoir ex League Battle Deck" while
          // /dp/B0D2JGYX3F served a Nex Playground games console, and B0BCC6N8YL alerted as a
          // Pokemon booster while serving a PopSockets phone grip. The sweep already makes
          // exactly these two checks at the AOD update branch; this path simply skipped them.
          if (data && data.name && !isInScopeName(data.name)) {
            logger.warn(`Amazon: ASIN ${product.sku} is no longer the product we stored — dropping. `
              + `Was "${product.name}", now "${data.name}"`);
            this._denyIdentity(product.sku, data.name);
            this._knownProducts.delete(product.sku);
            this._lastInStockAt.delete(product.sku);
            delete products[product.sku];
            continue;
          }
          if (data && data.name && product.name && !sameProductName(product.name, data.name)) {
            logger.warn(`Amazon: ASIN ${product.sku} was relisted — "${product.name}" -> "${data.name}"`);
            product.name = data.name;
            const reclassified = this.classify({ name: data.name }).category;
            if (reclassified !== 'other') product.category = reclassified;
          }

          if (data && data.price > 0) {
            product.price = data.price;
            // AOD settles STOCK too, not just price. The tile marked this out of stock only
            // because it showed no price; AOD reads the actual buy box (an offer listing id
            // plus a price), so if it says buyable, it is. Without this the item keeps a real
            // price and a false out-of-stock, and its restock still never fires — which was
            // the whole miss. Only ever raised here: a failed or negative read leaves the
            // item exactly as the tile had it, so this can add an alert but never suppress one.
            if (data.inStock) {
              product.inStock = true;
              product.canAddToCart = true;
              this._lastInStockAt.set(product.sku, Date.now()); // fresh in-stock read → hot lane
            }
            this._knownProducts.set(product.sku, product);
            logger.info(`Amazon: price-filled $${data.price} for ${product.sku} `
              + `(in stock, no price on search tile) — ${(product.name || '').slice(0, 50)}`);
          }
        } catch { /* leave price 0 — suppressed as before, retried next sighting */ }
      }
    }

    // Batch-ASIN stock sweep: check tracked ASINs by exact id so page-2-ranked items that keyword
    // relevance never surfaces (and that AOD can no longer check) still get a stock refresh. Runs
    // BEFORE the carry-forward so its fresh reads land in `products`; anything it did not touch this
    // poll is then carried forward unchanged.
    await this._runAsinSweep(products);

    // Offers lane: after the free sweep has refreshed everything it can, spend ONE paid
    // structured/offers call on the stalest search-invisible ASIN — the ones with no search tile,
    // which the sweep can never see. This is what guarantees a restock like B0H78BB9TY is caught.
    await this._runOffersLane(products);

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

    logger.info(`Amazon: SEARCH — ${hits}/${batch.length} queries (${batch.map(b => b.newest ? b.query + ' [newest]' : b.query).join(', ')}), ${found} results, ${this._knownProducts.size} known ASINs ($0)`);
  }

  /**
   * Batch-ASIN stock sweep — stock-check tracked ASINs by exact id over free /s search.
   *
   * Amazon's per-ASIN AOD checker is blocked, and keyword relevance never surfaces a page-2-ranked
   * item, so a tracked ASIN like B0H78BB9TY (30th Celebration ETB) could sit stale for hours and
   * miss its restock. This asks /s for pipe-joined ASIN batches (k=B0AAA|B0BBB, Amazon's OR
   * operator), which returns a normal results grid _parseSearchHtml already reads — the SAME free
   * endpoint + ISP pool as keyword search. A persistent cursor walks the catalogue a few chunks per
   * poll, so the full catalogue is checked every ~ceil(N / size / perPoll) polls without adding a
   * per-poll burst that could re-block /s (our only live detection leg).
   *
   * Fail-safe by construction: it only ever ADDS a fresh read. A challenge/empty page returns null
   * (never []), so those ASINs are carried forward, never flipped out of stock; and a priceless
   * tile still withholds rather than guessing (via _buildFromSearch), so no false OOS is possible.
   */
  async _runAsinSweep(products) {
    if (!ASIN_SWEEP_ENABLED) return;
    // Single-flight: a 120s poll timeout ORPHANS (does not cancel) a slow sweep while freeing the
    // poll guard, so the next poll could start a second sweep that races _asinSweepCursor. Skip if
    // one is already running — carry-forward fills the cache, so a skipped poll loses nothing.
    if (this._asinSweepInFlight) return;
    const all = [...this._knownProducts.keys()];
    if (all.length === 0) return;
    this._asinSweepInFlight = true;
    try {
      await this._runAsinSweepInner(products, all);
    } finally {
      this._asinSweepInFlight = false;
    }
  }

  async _runAsinSweepInner(products, all) {

    const chunks = [];
    for (let i = 0; i < all.length; i += ASIN_BATCH_SIZE) chunks.push(all.slice(i, i + ASIN_BATCH_SIZE));

    const toRun = [];
    for (let i = 0; i < ASIN_BATCHES_PER_POLL && i < chunks.length; i++) {
      toRun.push(chunks[this._asinSweepCursor % chunks.length]);
      this._asinSweepCursor = (this._asinSweepCursor + 1) % chunks.length;
    }

    const results = await Promise.allSettled(
      toRun.map(chunk => this._freeSearch(chunk.join('|'), false, 1, { asinMode: true }).then(items => ({ items })))
    );

    let refreshed = 0;
    let challenged = 0;
    for (const r of results) {
      if (r.status === 'rejected') continue;
      const { items } = r.value;
      // null = challenge / no grid: carry the cache forward, NEVER read as "these ASINs are OOS".
      if (items === null || items === undefined) { challenged++; continue; }
      for (const item of items) {
        // The keyword path (relevance + newest + its price-fill) already ran this poll. If it
        // surfaced this ASIN, its result stands — don't re-process and clobber a price-filled or
        // relist-adopted row. The sweep exists to cover what keyword search did NOT surface.
        if (item.asin && (item.asin in products)) continue;
        const product = this._buildFromSearch(item, '');
        if (!product) continue;
        products[product.sku] = product;
        this._knownProducts.set(product.sku, product);
        refreshed++;
      }
    }

    const asinCount = toRun.reduce((n, c) => n + c.length, 0);
    // Challenge hits are logged distinctly — a WAF page is HTTP 200 and invisible to error alarms.
    if (challenged) logger.warn(`Amazon: ASIN-sweep — ${challenged}/${toRun.length} batch(es) hit a challenge/empty page (carried forward, no OOS)`);
    logger.info(`Amazon: ASIN-sweep — ${toRun.length} batch(es) / ${asinCount} ASINs, ${refreshed} refreshed (cursor ${this._asinSweepCursor}/${chunks.length}) ($0)`);
  }

  /**
   * Apply the PINNED-offer stock rule to a structured/amazon/offers payload.
   *
   * Stock is whether the FEATURED (buy-box) offer carries a numeric price — NOT listings.length,
   * and NOT "any priced listing". Marketplace listings carry prices whether or not anything is
   * featured, so B0C75FSW7C (unpriced pinned offer + four priced marketplace listings, no buy box)
   * is OOS; both naive rules would call it in stock. Fallback if nothing is flagged pinned: read
   * listings[0] (degrade to "top offer", never to "in stock"). Returns null when the payload is
   * unreadable (no live title = WAF/challenge/empty) so the caller carries the cache forward.
   * Kept in lock-step with parseOffers in src/utils/amazon-verify.js.
   */
  // Thin seam over the module fetcher so tests can stub the network. Returns raw offers JSON or null.
  _fetchOffers(asin) {
    return fetchAmazonOffers(asin);
  }

  _offersToData(json) {
    if (!json || typeof json !== 'object') return null;
    const name = json.item && json.item.name;
    if (!name) return null; // no live title => we did not really read the page => inconclusive
    const listings = Array.isArray(json.listings) ? json.listings : [];
    const pinned = listings.find(l => l && l.pinned_offer) || listings[0] || null;
    const price = pinned && Number(pinned.price) > 0 ? Number(pinned.price) : null;
    return { name, price, inStock: price != null };
  }

  /**
   * Offers lane — one paid structured/offers check per interval on the stalest search-invisible
   * ASIN, so an item with no search tile still gets a definitive stock verdict and its restock
   * fires. Stalest-first is self-balancing (no starvation); paced by OFFERS_INTERVAL_MS and a hard
   * daily credit cap. Fail-safe: an unreadable payload or budget refusal returns null / no-ops and
   * carries the cache forward — it can never flip a batch of ASINs out of stock.
   */
  async _runOffersLane(products) {
    if (!OFFERS_LANE_ENABLED) return;
    const now = Date.now();
    if (now - this._lastOffersAt < OFFERS_INTERVAL_MS) return; // one paid call per interval

    // Hard daily cap, reset on date change — never spend the whole ScraperAPI margin on this lane.
    const day = new Date(now).toISOString().slice(0, 10);
    if (this._offersDay !== day) { this._offersDay = day; this._offersToday = 0; }
    if (this._offersToday >= OFFERS_DAILY_CAP) return;

    // Target the stalest tracked ASIN the free sweep hasn't refreshed within OFFERS_STALE_MS — i.e.
    // the ones with no search tile. Stalest-first guarantees fair coverage of the whole invisible set.
    let target = null;
    let oldest = Infinity;
    for (const [asin, p] of this._knownProducts) {
      const ls = (p && p.lastSeen) || 0;
      if (now - ls > OFFERS_STALE_MS && ls < oldest) { oldest = ls; target = asin; }
    }
    if (!target) return;

    this._lastOffersAt = now;
    let json;
    try { json = await this._fetchOffers(target); } catch { json = null; }
    if (json === null) return; // budget refusal / HTTP error / timeout — no data, carry forward
    this._offersToday += 1;

    const data = this._offersToData(json);
    if (!data) { // unreadable (no live title) — carry forward, NEVER read as OOS
      logger.debug(`Amazon: offers-lane — ${target} unreadable payload, carried forward`);
      return;
    }

    // Identity: a live title now out of scope means this ASIN is no longer the product we stored.
    // DENYLIST it, not just evict — the offers read is a definitive live-title verdict, and an evict
    // alone lets the next search tile re-admit the same wrong mapping (exactly what kept a magnesium
    // ASIN stamped as a Gardevoir deck alive poll after poll). Persisting the denial makes it stick.
    if (!isInScopeName(data.name)) {
      logger.warn(`Amazon: offers-lane — ${target} live title out of scope ("${data.name.slice(0, 60)}") — denylisting`);
      this._denyIdentity(target, data.name);
      this._knownProducts.delete(target);
      delete products[target];
      return;
    }

    const cached = this._knownProducts.get(target) || {};
    // Adopt a relisted title only when it genuinely changed (mirror the sweep); keep the discovered
    // category unless the live title re-classifies to a concrete game.
    let name = cached.name;
    let category = cached.category;
    if (data.name && cached.name && !sameProductName(cached.name, data.name)) {
      name = data.name;
      const reclassified = this.classify({ name: data.name }).category;
      if (reclassified !== 'other') category = reclassified;
    } else if (data.name && !cached.name) {
      name = data.name;
    }

    const product = {
      ...cached,
      sku: target,
      name: name || cached.name || data.name,
      category: category || cached.category || 'pokemon',
      price: data.price || cached.price || 0,
      inStock: data.inStock,
      canAddToCart: data.inStock,
      url: cached.url || `https://www.amazon.ca/dp/${target}`,
      lastSeen: now,
    };
    products[target] = product;
    this._knownProducts.set(target, product);
    if (data.inStock) this._lastInStockAt.set(target, now);

    logger.info(`Amazon: offers-lane — ${target} ${data.inStock ? `IN STOCK $${data.price}` : 'OOS'}`
      + ` (${this._offersToday}/${OFFERS_DAILY_CAP} credits today, oldest ${Math.round((now - oldest) / 60000)}min)`);
  }

  /**
   * Free search against amazon.ca. The old path spent 5 ScraperAPI credits per query and
   * so could only run every 30 minutes, which meant a brand-new listing went unnoticed
   * for up to half an hour. Plain search returns ASIN, title, price and stock for ~40
   * products per query and is not gated, so this can run on every poll for nothing.
   */
  async _freeSearch(query, newestFirst = false, page = 1, opts = {}) {
    const { asinMode = false } = opts;
    // Amazon's default sort is RELEVANCE, and a brand-new listing has no traction yet, so it
    // does not rank — which is how three "30th Celebration" products were listed, sold out and
    // gone before we ever saw one. Measured 2026-09-09 on the same query: the newest-first sort
    // returned 24 tiles of which 23 do not appear in relevance results at all. Almost no
    // overlap, so this is not a marginal gain — it is a different view of the catalogue, and it
    // is the one where a new listing appears immediately.
    // ASIN-batch mode: `query` is a pipe-joined ASIN list. Drop the &i=toys department filter — an
    // exact-ASIN search needs no category scope, and the filter would silently hide any tracked
    // ASIN Amazon has re-categorised out of Toys & Games — and skip the relevance sort/page params.
    const dept = asinMode ? '' : '&i=toys';
    const sort = (!asinMode && newestFirst) ? '&s=date-desc-rank' : '';
    const pageParam = (!asinMode && page > 1) ? `&page=${page}` : ''; // Amazon paginates in the query string
    const url = `https://www.amazon.ca/s?k=${encodeURIComponent(query)}${dept}${sort}${pageParam}`;

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
      const viaIsp = await this._searchOnce(url, isp.url, opts);
      if (viaIsp) return viaIsp;
    }

    // Direct is ONE address, and it is the address Amazon already blocked once for 14 hours.
    //
    // Widening the pool divides the proxied rate but does nothing for this leg: every exit
    // that fails falls through to here, so the worse things get, the harder this runs. At 13
    // queries per poll a bad patch would land 2.17 req/s on Railway's single IP — 3.2x the
    // 0.67 req/s that caused the original block. Paced to one request per poll interval, the
    // rate this adapter ran safely for weeks. Skipping costs one query for one cycle; not
    // skipping costs the address.
    //
    // Only paced when a pool EXISTS. With no ISP proxies configured, direct is the only route
    // there is and throttling it would silently disable Amazon search altogether.
    if (isp) {
      const now = Date.now();
      if (now - (this._lastDirectAt || 0) < this.intervalMs) return null;
      this._lastDirectAt = now;
    }
    return this._searchOnce(url, null, opts);
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

  async _searchOnce(url, proxyUrl, opts = {}) {
    const { asinMode = false } = opts;
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
      if (asinMode) {
        // ASIN-batch pages are small by design (~20 tiles), so the keyword path's 50KB floor would
        // falsely reject a GOOD grid. Gate on the RESULTS GRID instead: a challenge/robot-check page
        // (checked first, at any size) or any response without the grid marker returns null — never
        // [] — so a bad page is "no data this cycle, carry the cache forward", and a batch can NEVER
        // read as "these 20 ASINs went out of stock".
        if (html && /api-services-support|Type the characters|continue shopping/.test(html)) {
          if (proxyUrl) _clearCache(proxyUrl);
          return null;
        }
        if (!html || !html.includes('data-component-type="s-search-result"')) return null;
        return this._parseSearchHtml(html);
      }
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
      // Not every product tile carries the s-search-result marker we split on, so one `card`
      // slice can hold several tiles. The ASIN above belongs to the FIRST tile in the slice;
      // confine every OTHER field to that tile by truncating at the next tile's csa-id. Without
      // this, the name/alt/price/image regexes reach forward into the next tile and staple a
      // neighbour's title and price onto this ASIN — which is exactly how magnesium ASIN
      // B0DRDRVZZT got the "Gardevoir ex League Battle Deck" name + $81.87 and fired false
      // restock/price-drop alerts. A marker-less foreign tile now has no h2 of its OWN and is
      // dropped at the `if (!ariaName) continue` below instead of contaminating a real product.
      const _idAt = card.indexOf('data-csa-c-item-id="amzn1.asin.' + asin);
      const _nextId = _idAt < 0 ? -1 : card.indexOf('data-csa-c-item-id="amzn1.asin.', _idAt + 31);
      const tile = _nextId === -1 ? card : card.slice(0, _nextId);
      const ariaName = (tile.match(/<h2[^>]*aria-label="([^"]{8,200})"/) || [])[1];
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
      const altRaw = (tile.match(/class="s-image"[^>]*alt="([^"]{8,250})"/) || [])[1];
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
      const priceStr = (tile.match(/data-cy="price-recipe"[\s\S]{0,1200}?a-offscreen">\$([\d,]+\.\d{2})/) || [])[1];
      const price = priceStr ? normalizePrice(priceStr) : null;
      // A search card only shows a price when the item is buyable
      const oos = /Currently unavailable|Temporarily out of stock/i.test(tile);
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
        // A tile with no price is NOT evidence of being unavailable. Amazon prices some
        // genuinely buyable items only on their own product page — B0GW2DK37Q ("First Partner
        // Illustration Collection Series 2") is one — and the line above marks every one of
        // them out of stock, because a price is the only stock signal a tile reliably carries.
        //
        // Measured on 90 live tiles: 43 had no price, and NONE of them were marked in stock.
        // That is why price-filling keyed on "inStock && no price" never once ran in
        // production — the two conditions cannot both hold here. Flag the ambiguity instead
        // and let the AOD fetch settle it, since that reads the real buy box.
        _priceUnknown: !priceStr && !oos,
        image: (tile.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com[^"]+)"/) || [])[1] || '',
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

    // An ASIN we have PROVEN serves a different product cannot be re-admitted by a search tile.
    //
    // Amazon's search index lags its product pages. B0F1T9ND7G was still on page 1 of "pokemon
    // booster pack" carrying the stale Pokemon title AND its old $22.96 price, while
    // /dp/B0F1T9ND7G served a car jump starter. Without this gate, dropping the ASIN on a live
    // title and deleting its row both get undone by the next sighting of that stale tile — and
    // the re-admit arrives as inStock:true, which is exactly the wrong-product alert.
    if (this._denied.has(item.asin)) return null;
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
    if (!hasGameScope(haystack)) return null;

    const cached = this._knownProducts.get(item.asin) || {};
    const product = this.classify({
      ...cached,
      sku: item.asin,
      name: item.name,
      price: item.price ?? cached.price ?? 0,
      currency: 'CAD',
      url: `https://www.amazon.ca/dp/${item.asin}`,
      image: item.image || cached.image || '',
      // A tile with no price carries NO stock signal, so it must not assert "out of stock"
      // over what AOD established from a real buy box. Without this guard the poll right after
      // a successful price-fill overwrote inStock:true with false; the item was no longer
      // queued for a lookup (it now had a cached price), and the five-minute AOD sweep flipped
      // it back — producing alert, out-of-stock, alert, on a loop. A tile that knows nothing
      // must say nothing, and an item never resolved simply stays false as before.
      inStock: item._priceUnknown ? (cached.inStock ?? false) : item.inStock,
      canAddToCart: item._priceUnknown ? (cached.canAddToCart ?? false) : item.inStock,
      shipsToHome: true,
      lastSeen: Date.now(),
    });

    // Carried through so discovery can tell "no price shown" apart from "priced at nothing".
    product._priceUnknown = !!item._priceUnknown;

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

    // A fresh in-stock tile (one carrying a real price signal) is a genuine sighting → feed the
    // auto-hot lane. A price-unknown tile asserts nothing about stock, so it never stamps.
    if (!item._priceUnknown && item.inStock) this._lastInStockAt.set(item.asin, Date.now());
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
    // Single-flight: the 120s poll timeout ORPHANS a long sweep (JS can't cancel it) but frees the
    // poll guard, so the next poll could start a second sweep that races this one over _aodCursor
    // and _knownProducts. Skip if one is already running — the carried-forward cache (set in
    // _runDiscovery before the sweep) already fills `products`, so nothing is lost by skipping.
    if (this._sweepInFlight) return;
    this._sweepInFlight = true;
    try {
      return await this._monitorKnownAsinsInner(products);
    } finally {
      this._sweepInFlight = false;
    }
  }

  async _monitorKnownAsinsInner(products) {
    // Hot ASINs are covered by the fast lane (getFastPollAsins); skip them here so the sweep spends
    // the shared AOD budget only on the cold long tail and never double-checks a hot item.
    const hot = this.getFastPollAsins();
    const all = [...this._knownProducts.keys()].filter(asin => !hot.has(asin));
    if (all.length === 0) {
      logger.debug('Amazon: no known ASINs — waiting for discovery');
      return;
    }
    // Start where the last sweep stopped, not at index 0. A clean full pass still covers every
    // ASIN (the rotation wraps back to the start); the difference is that a throttle-break now
    // resumes at the tail on the next sweep instead of re-walking the front and starving the
    // back of the list.
    const start = this._aodCursor % all.length;
    const asins = all.slice(start).concat(all.slice(0, start));

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
    let processed = 0; // ASINs attempted this sweep, to advance the persistent cursor
    const BATCH = 1;

    for (let i = 0; i < asins.length; i += BATCH) {
      const batch = asins.slice(i, i + BATCH);
      processed += batch.length;
      const results = await Promise.allSettled(
        batch.map((asin) => {
          // Read the throttle signal PER CALL via a private ctx, never the shared
          // _lastFetchThrottled field. Three lanes (hot/watchlist, sweep, price-fill) call
          // _stealthCheckAsin concurrently; a sibling lane's clean read or budget miss could
          // otherwise clear a genuine 503 before the sweep reads it — masking the strike so the
          // 10-min cooldown never fires and the sweep keeps hammering a throttled endpoint.
          const ctx = { throttled: false };
          return this._stealthCheckAsin(asin, 1, ctx).then(data => ({ asin, data, throttled: ctx.throttled }));
        }),
      );

      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { asin, data, throttled: wasThrottled } = result.value;
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
            this._denyIdentity(asin, data.name);
            this._knownProducts.delete(asin);
            this._lastInStockAt.delete(asin);
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

          // A titleless read may not RAISE stock.
          //
          // Both identity checks above require `data.name`, and _parseAod returns a row with
          // name:null whenever the title regex misses but an offer parses. So a titleless read
          // skips the drop check AND the relist check, yet still adopted inStock — which is the
          // one transition that fires an alert. That is how a repurposed listing announces
          // itself under the name of the product it replaced.
          //
          // Only the upward direction is withheld: a titleless read may still take a product
          // OUT of stock, still update price and image, and a read that does carry a title is
          // unaffected.
          //
          // Cost: normally one fast-lane re-check (~30s), because the ASIN is stamped hot below.
          // But BOTH lanes go through _stealthCheckAsin, which returns null for everything while
          // the AOD cooldown holds — and that ladder escalates 10/20/40min. So a withheld restock
          // landing just before a deep block can wait as long as the current rung. That is
          // acceptable only because a titleless read is rare by construction: _parseAod discards
          // a read with no title unless an offer id AND a price parsed, and those sit in the same
          // block as the title.
          const raisesStockBlind = data.inStock && !cached?.inStock && !data.name;
          if (raisesStockBlind) {
            logger.warn(`Amazon: ASIN ${asin} read in stock with NO title — holding the restock `
              + `until the identity is confirmed (stored as "${cached?.name || 'unknown'}")`);
          }

          // Keep cached identity (category, retailer) — update name, price + stock
          const product = {
            ...cached,
            name: name || cached?.name,
            category: category || cached?.category,
            price: data.price || cached.price,
            inStock: raisesStockBlind ? cached.inStock : data.inStock,
            canAddToCart: raisesStockBlind ? cached.canAddToCart : data.inStock,
            image: data.image || cached.image,
            lastSeen: Date.now(),
          };
          this._knownProducts.set(asin, product);
          products[asin] = product;
          // Fresh in-stock read → keep the ASIN in the auto-hot lane (stamped only on a real
          // sighting, never from a carried-forward row, so hotness genuinely decays after 48h).
          //
          // A withheld blind restock is stamped too, deliberately. We saw stock but refused to
          // publish it for want of a title, so the useful thing is to look again SOON: the hot
          // lane re-reads in ~30s rather than waiting out the ~5min cold sweep, and the next
          // read that carries a title either confirms the restock or drops the ASIN. Without
          // this, the guard's cost would be a genuine restock delayed by a full sweep.
          if (product.inStock || raisesStockBlind) this._lastInStockAt.set(asin, Date.now());
        } else {
          // Fetch failed — return cached data unchanged (no false OOS events)
          if (wasThrottled) throttled++;
          const cached = this._knownProducts.get(asin);
          if (cached) products[asin] = cached;
        }
      }

      // Back off the whole pass as soon as Amazon starts throttling, rather than walking the rest
      // of the list into the same wall. The cooldown itself is set centrally in _aodStrike (so the
      // hot lane and price-fill trip and observe it too) — here we just stop this pass and carry
      // the cache forward so nothing diffs as a false OOS.
      if (throttled >= AOD_THROTTLE_STRIKES) {
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

    // Advance the persistent cursor past what we attempted, so the next sweep continues from
    // here — a break leaves it at the tail, a full pass wraps it back to the start.
    this._aodCursor = (start + processed) % all.length;

    this.reportFreshness(updated, checked);
    this._monitorSuccessRate = checked > 0 ? Math.round((updated / checked) * 100) : 0;
    logger.info(`Amazon: MONITOR — ${updated}/${checked} ASINs updated (free stealth). ${this._monitorSuccessRate}% success.${throttled ? ` ${throttled} throttled.` : ''}`);
  }

  /**
   * Fetch a single product page — used by watchlist fast-polling.
   */
  async fetchProductPage(asin) {
    // Priority 0: the watchlist/hot lane is what restock latency is measured on, so it wins the
    // shared AOD budget over the background sweep.
    const data = await this._stealthCheckAsin(asin, 0);
    // A titleless read is not usable here and must not throw. `data.name` is null whenever the
    // title regex missed but an offer parsed, and the next line called .toLowerCase() on it —
    // a TypeError that escapes into pollWatchlist, whose try wraps the WHOLE loop, so one bad
    // read aborted the entire fast-poll pass. Every hot ASIN after it is then polled by neither
    // lane, because the sweep deliberately skips hot ASINs. This is also the exact input the
    // sweep's blind-restock guard now steers into this path, so it has to be safe.
    if (!data || !data.name) return null;

    // Apply game name + TCG filters
    const lowerName = data.name.toLowerCase();
    const hasGameName = hasGameScope(lowerName);
    if (!hasGameName) return null;
    if (!isTCGProduct(data.name)) return null;

    if (data.inStock) this._lastInStockAt.set(asin, Date.now()); // keeps it in the fast lane

    const product = this.classify({
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
    // Reconcile _knownProducts with what the fast loop just read. The sweep SKIPS hot ASINs, so
    // without this the main poll would keep carrying a stale cached row for a fast-lane ASIN and
    // diff it against the fresh row the watchlist loop wrote to Redis — a false-OOS state write
    // that then arms a false RESTOCK. Keeping both writers on the same value makes them agree.
    this._knownProducts.set(asin, product);
    return product;
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
        const hasGameName = hasGameScope(lowerName);
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
