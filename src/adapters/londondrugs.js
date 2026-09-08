const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const scraperApi = require('../utils/scraper-api');
const storeAvail = require('../utils/ld-store-availability');
const state = require('../core/state');

/**
 * London Drugs — Next.js App Router storefront behind DataDome.
 *
 * Everything we need (price, availability, stock level, fulfilment) is server-rendered
 * into the RSC flight payload, so no JS execution is required — a plain GET is enough.
 *
 * Access, measured rather than assumed:
 *   direct / ISP proxy   403 (DataDome rejects datacenter IPs outright)
 *   residential          7/10 success, median 3.4s, ~44KB wire — but $12/GB
 *   ScraperAPI standard  10/10 success, median 6.2s, 1 credit per call
 * ScraperAPI standard is the primary because it is both more reliable and effectively
 * free against an idle 1M-credit budget; residential is the fallback. Every London Drugs
 * TCG item is InStorePickup with no DirectShip, so this is a reserve-for-pickup store
 * rather than a checkout race and the extra 1.5s of latency buys nothing worth $43/mo.
 */

// The Pokemon category carries every sealed TCG product the store lists, verified against a
// full 176-sitemap sweep of all 29,775 products: 41 card hits, 41 of them inside this category.
const FAST_PATH = '/category/pokemon/c/1622?pageSize=200';
// Wider net, polled slowly: catches anything card-related that lands outside the Pokemon
// category (One Piece, say — London Drugs lists none today, and this is how we'd find out).
const SWEEP_PATH = '/category/trading-cards-and-collectibles/c/977?pageSize=200';

const SWEEP_INTERVAL_DEFAULT = 15 * 60 * 1000;
const SWEEP_INTERVAL_FLOOR = 5 * 60 * 1000;

// pageSize is honoured server-side (16 default -> 200); `sort=`, `Price=` and `categoryId=`
// are all Disallow'd in robots.txt, and `/search*` with them, so discovery uses categories
// and the sitemap only — never search.
const SCRAPER_OPTS = { render: false, premium: false, ultraPremium: false };

// Store enrichment cadence. Each pass costs one Bright Data browser session, so the floor is
// deliberately high — this is background colour on an alert, not a detection path.
const STORE_ENRICH_DEFAULT = 30 * 60 * 1000;
const STORE_ENRICH_FLOOR = 10 * 60 * 1000;
// Enough to name the nearest store and count the rest without bloating every Redis row.
const STORE_ROWS_KEPT = 5;

const GAME_NAMES = ['pokemon', 'pokémon', 'pokmon', 'one piece'];
const PRODUCT_FORMS = [
  'tcg', 'trading card game', 'booster', 'elite trainer', 'etb', 'collection box',
  'premium collection', 'ex box', 'card game', 'tin', 'blister', 'battle deck',
  'build & battle', 'build and battle', 'booster bundle',
];
// Pokemon-branded storage carries a game name and a card form but is never the drop
// anyone is waiting on. Costco needed the same split.
const ACCESSORY_TERMS = [
  'card book', 'portfolio', 'binder', 'sleeve', 'deck protector', 'pocket pages',
  'card case', 'playmat', 'toploader', 'deck box',
];

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Next.js streams its data as self.__next_f.push([1,"<escaped chunk>"]).
 * Concatenating the decoded chunks reconstructs the RSC flight payload.
 */
function flightOf(html) {
  let out = '';
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    try { out += JSON.parse(m[1]); } catch { /* a truncated chunk is not fatal */ }
  }
  return out;
}

/**
 * The payload is newline-separated "<hexid>:<json>" rows whose values may be "$<hexid>"
 * pointers into other rows, so it has to be resolved before products make sense.
 */
function parseFlightProducts(html) {
  const flight = flightOf(html);
  const rows = new Map();
  const re = /^([0-9a-f]+):([[{"].*)$/gm;
  let m;
  while ((m = re.exec(flight))) {
    try { rows.set(m[1], JSON.parse(m[2])); } catch { /* not every row is JSON */ }
  }

  const memo = new Map();
  function resolve(value, depth = 0) {
    if (depth > 12) return value;
    if (typeof value === 'string') {
      if (value === '$undefined') return undefined;
      const id = value.startsWith('$') ? value.slice(1) : null;
      if (id && rows.has(id)) {
        if (memo.has(id)) return memo.get(id);
        memo.set(id, undefined); // cycle guard
        const out = resolve(rows.get(id), depth + 1);
        memo.set(id, out);
        return out;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => resolve(v, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = resolve(v, depth + 1);
      return out;
    }
    return value;
  }

  const seen = new Set();
  const products = [];
  for (const [, raw] of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (!raw.productCode || !('isAvailable' in raw)) continue;
    const p = resolve(raw);
    if (!p || seen.has(p.productCode)) continue;
    seen.add(p.productCode);
    products.push(p);
  }
  return products;
}

/** Product objects carry no URL, so the slugs are recovered from the surrounding HTML. */
function slugMap(html) {
  const map = new Map();
  for (const m of String(html || '').matchAll(/\/products\/([a-z0-9-]{3,120})\/p\/(L\d+)/gi)) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

function isTrackedCardProduct(name) {
  const t = String(name || '').toLowerCase();
  if (!GAME_NAMES.some((g) => t.includes(g))) return false;
  if (ACCESSORY_TERMS.some((a) => t.includes(a))) return false;
  return PRODUCT_FORMS.some((f) => t.includes(f));
}

class LondonDrugsAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this._known = new Map(); // sku -> classified product
    this._lastSweepAt = 0;
    this._sweepRunning = false;
    this._stores = new Map();        // sku -> store rows with stock, from the enrichment pass
    this._storesAt = 0;
    this._storesRunning = false;
    this._deriveTiming();
  }

  _deriveTiming() {
    this.sweepIntervalMs = this.timingValue('sweepIntervalMs', SWEEP_INTERVAL_DEFAULT, SWEEP_INTERVAL_FLOOR);
    this.storeEnrichIntervalMs = this.timingValue('storeEnrichIntervalMs', STORE_ENRICH_DEFAULT, STORE_ENRICH_FLOOR);
  }

  applyTiming(timing) {
    super.applyTiming(timing);
    this._deriveTiming();
  }

  /**
   * ScraperAPI first (reliable and effectively free), residential second. Residential is
   * only reached when ScraperAPI is unconfigured, budget-paused or errors, so the $12/GB
   * meter stays near zero in normal operation.
   */
  async _fetchCategory(path) {
    const url = `${this.url}${path}`;
    let scraperErr = null;

    if (scraperApi.isConfigured()) {
      try {
        const html = await scraperApi.scraperFetch(url, {
          ...SCRAPER_OPTS,
          retailerId: this.id,
          // The shared 5-minute floor exists to protect a 100K credit budget on
          // 25-credit calls. These are 1-credit calls, so the poll interval governs.
          minIntervalMs: 0,
          timeoutMs: 45000,
        });
        // null means rate-limited or budget-paused, not a failure — fall through to residential
        if (html && html.length > 5000) return html;
        if (html) throw new Error(`short response (${html.length} bytes)`);
      } catch (err) {
        scraperErr = err;
        logger.debug(`${this.name}: ScraperAPI failed (${err.message}), trying residential`);
      }
    }

    const html = await this.stealthFetch(url, { timeoutMs: 45000, maxRetries: 2, retryDelayMs: 800 });
    if (!html || html.length < 5000) {
      throw new Error(`residential returned ${html ? `${html.length} bytes` : 'nothing'}` +
        (scraperErr ? ` (ScraperAPI: ${scraperErr.message})` : ''));
    }
    return html;
  }

  _toProducts(html) {
    const slugs = slugMap(html);
    const out = [];
    for (const p of parseFlightProducts(html)) {
      const name = decodeEntities(p.productName);
      if (!isTrackedCardProduct(name)) continue;

      const price = p.price || {};
      const value = price.salePrice ?? price.price ?? price.listPrice ?? 0;
      const listPrice = price.listPrice ?? null;
      const fulfilment = Array.isArray(p.supportedFulfilmentTypes) ? p.supportedFulfilmentTypes : [];
      const slug = slugs.get(p.productCode);
      // Named stockCount because that is the field the embed reads. It was called stockLevel,
      // which nothing outside this file has ever looked at, so every London Drugs alert showed
      // "Stock: 1+" while the exact quantity sat in the payload we had already paid to fetch.
      const stockCount = p.inventory && typeof p.inventory.onlineStockLevel === 'number'
        ? p.inventory.onlineStockLevel
        : null;

      out.push(this.classify({
        sku: p.productCode,
        name,
        price: Number(value) || 0,
        listPrice: listPrice !== null ? Number(listPrice) : undefined,
        currency: 'CAD',
        url: slug
          ? `${this.url}/products/${slug}/p/${p.productCode}`
          : `${this.url}/products/p/${p.productCode}`,
        image: '',
        inStock: !!p.isAvailable,
        canAddToCart: !!p.isAvailable,
        // London Drugs does not ship TCG — every item is pickup-only. Saying otherwise
        // in an embed would be a wrong field, which is worse than a missing one.
        shipsToHome: fulfilment.includes('DirectShip'),
        pickupOnly: fulfilment.length > 0 && !fulfilment.includes('DirectShip'),
        stockCount,
        maxOrderQty: p.maxOrderableQuantity ?? null,
        seller: 'London Drugs',
        isPreorderable: /pre-?order/i.test(name),
      }));
    }
    return out;
  }

  /** Redis key holding sku -> store rows for this retailer. */
  get _storesKey() { return `tcg:stores:${this.id}`; }

  /** Persist the enrichment result so the next poll — or the next process — can see it. */
  async _saveStores() {
    try {
      const redis = state.getRedis();
      if (!redis) return;
      const obj = Object.fromEntries(this._stores);
      // Two hours: comfortably longer than the enrichment interval, short enough that store
      // counts cannot go stale enough to mislead if enrichment stops.
      await redis.set(this._storesKey, JSON.stringify(obj), 'EX', 7200);
      logger.info(`${this.name}: store data persisted for ${Object.keys(obj).length} product(s)`);
    } catch (err) {
      logger.warn(`${this.name}: could not persist store data: ${err.message}`);
    }
  }

  /** Load store rows written by any process. Never throws — a miss just means no store field. */
  async _loadStores() {
    try {
      const redis = state.getRedis();
      if (!redis) return;
      // Bounded: the poll must never stall on a slow or unreachable Redis. A miss here costs
      // the store field on this cycle, nothing more.
      const raw = await Promise.race([
        redis.get(this._storesKey),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      if (!raw) return;
      const obj = JSON.parse(raw);
      for (const [sku, rows] of Object.entries(obj)) {
        if (Array.isArray(rows) && rows.length) this._stores.set(sku, rows);
      }
    } catch (err) {
      logger.debug(`${this.name}: could not load store data: ${err.message}`);
    }
  }

  /**
   * Refresh per-store availability in the background, on a slow timer.
   *
   * Never awaited by the poll. A lookup costs a Bright Data browser session — measured 22.1s to
   * open plus ~1.5-4s per product — so it is far too slow to sit in front of an alert, and it is
   * billed per GB. Only in-stock products are looked up: a store cannot hold units of something
   * the chain does not have online, and skipping the other ~17 products cuts the pass by most of
   * its cost.
   */
  _maybeEnrichStores() {
    const due = Date.now() - this._storesAt >= this.storeEnrichIntervalMs;
    if (!due || this._storesRunning) return;

    // Work out the targets BEFORE stamping the clock. This runs at the top of the poll, so on
    // the first pass after a restart the catalogue is still empty — stamping first meant that
    // empty pass consumed the whole 30-minute interval and store data never appeared at all.
    const targets = [...this._known.values()].filter((p) => p.inStock && p.url)
      .map((p) => ({ sku: p.sku, url: p.url }));
    if (targets.length === 0) return; // nothing to enrich yet — try again next poll

    // Seed the session on a PRODUCT page, never the homepage. Next.js server actions are
    // route-scoped: posting one from the wrong route returns a different payload entirely,
    // which parsed into rows that had no stockAvailable and therefore no stock. It logged a
    // confident "9/9 products" while producing nothing usable.
    const openSession = storeAvail.createBrightDataSession(targets[0].url);
    if (!openSession) return; // no browser endpoint configured — alerts simply omit the store

    this._storesRunning = true;
    this._storesAt = Date.now();

    storeAvail.fetchStoreAvailability(targets, { openSession })
      .then((map) => {
        let kept = 0;
        for (const [sku, rows] of map) {
          const withStock = storeAvail.storesWithStock(rows).slice(0, STORE_ROWS_KEPT);
          if (withStock.length) { this._stores.set(sku, withStock); kept++; }
          else this._stores.delete(sku);
        }
        logger.info(`${this.name}: store data kept for ${kept}/${map.size} product(s)`);
        return this._saveStores();
      })
      .catch((err) => logger.warn(`${this.name}: store enrichment failed: ${err.message}`))
      .finally(() => { this._storesRunning = false; });
  }

  /** Wide sweep — replaces the catalogue so delisted products actually disappear. */
  async _sweep() {
    this._sweepRunning = true;
    const start = Date.now();
    try {
      const html = await this._fetchCategory(SWEEP_PATH);
      const found = this._toProducts(html);
      if (found.length === 0) throw new Error('sweep parsed 0 in-scope products');

      const fresh = new Map(found.map((p) => [p.sku, p]));
      // A fast-poll observation is newer than a sweep that started before it; keep it.
      for (const [sku, old] of this._known) {
        const next = fresh.get(sku);
        if (next && old.lastSeen > next.lastSeen) fresh.set(sku, old);
      }
      const added = found.filter((p) => !this._known.has(p.sku)).length;
      const dropped = [...this._known.keys()].filter((sku) => !fresh.has(sku)).length;
      this._known = fresh;
      this._lastSweepAt = Date.now();
      logger.info(`${this.name}: SWEEP — ${fresh.size} products` +
        `${added ? `, ${added} new` : ''}${dropped ? `, ${dropped} delisted` : ''}, ${Date.now() - start}ms`);
    } finally {
      this._sweepRunning = false;
    }
  }

  async fetchProducts() {
    const start = Date.now();

    if (!this._sweepRunning && Date.now() - this._lastSweepAt >= this.sweepIntervalMs) {
      // Backgrounded so a slow sweep can't blow the scheduler's adapter timeout.
      this._sweep().catch((err) => logger.warn(`${this.name}: sweep failed: ${err.message}`));
    }

    this._maybeEnrichStores();

    const html = await this._fetchCategory(FAST_PATH);
    const found = this._toProducts(html);

    // A parse that suddenly yields nothing means the page shape changed or we were served
    // a challenge — not that London Drugs delisted its entire Pokemon catalogue. Throwing
    // leaves the previous state intact instead of firing an out-of-stock alert for everything.
    if (found.length === 0 && this._known.size > 0) {
      throw new Error(`fast poll parsed 0 in-scope products (had ${this._known.size})`);
    }

    // Attach the last known per-store availability. It is enrichment, so it lags the stock
    // number by up to one enrichment interval — acceptable here only because London Drugs is
    // pickup-only and therefore not a checkout race.
    // Read the cache through Redis rather than trusting instance memory.
    //
    // The enrichment reported "kept for 9/9 product(s)" while every poll attached nothing, and
    // the attach logic is provably correct in isolation — so the cache simply was not there by
    // the time the next poll ran. Rather than keep theorising about why in-process state went
    // missing, the store data now lives in Redis: it survives a restart, it is inspectable from
    // outside, and the attach no longer depends on two callbacks sharing an object.
    await this._loadStores();

    let attached = 0;
    for (const p of found) {
      const stores = this._stores.get(p.sku);
      if (stores && stores.length) { p._stores = stores; attached++; }
    }
    // The cache filling but nothing reaching an alert is a silent failure, and it already cost
    // three rounds of guessing. Say it out loud whenever the cache has entries: if attached is
    // 0 while the cache is not, the two are keyed differently and the keys are printed to prove it.
    if (this._stores.size > 0 && attached === 0) {
      logger.warn(`${this.name}: store cache has ${this._stores.size} entries but attached to 0 ` +
        `of ${found.length} products — cache keys [${[...this._stores.keys()].slice(0, 3).join(', ')}] ` +
        `vs product keys [${found.slice(0, 3).map((p) => p.sku).join(', ')}]`);
    } else if (attached > 0) {
      logger.debug(`${this.name}: store field attached to ${attached}/${found.length} products`);
    }

    for (const p of found) this._known.set(p.sku, p);
    this.reportFreshness(found.length, Math.max(found.length, this._known.size ? found.length : 0));

    const inStock = found.filter((p) => p.inStock).length;
    logger.info(`${this.name}: FAST — ${found.length} tracked products (${inStock} in stock), ${Date.now() - start}ms`);

    return Object.fromEntries(this._known);
  }
}

module.exports = LondonDrugsAdapter;
module.exports.parseFlightProducts = parseFlightProducts;
module.exports.isTrackedCardProduct = isTrackedCardProduct;
module.exports.slugMap = slugMap;
module.exports.decodeEntities = decodeEntities;
