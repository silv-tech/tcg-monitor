const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const scraperApi = require('../utils/scraper-api');
const storeAvail = require('../utils/ld-store-availability');
const state = require('../core/state');
const { sleep } = require('../utils/helpers');

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

// Product images live on the Kibo CDN, keyed by product code. The storefront builds them from
// kiboImagesFilePath in its own bundle — ".../cms/files/dynamicProductCode.jpg" with the code
// substituted — which is where this pattern comes from rather than guesswork. Verified 200
// image/jpeg on five separate SKUs; the -S/-M/-L size suffixes the bundle also references all
// 404, so only the bare code resolves.
const IMAGE_BASE = process.env.LD_IMAGE_BASE
  || 'https://cdn-tp2.mozu.com/28945-m4/cms/files';

// Store enrichment cadence. One plain GET per tracked product, so a pass costs one ScraperAPI
// credit per product — cheap, but not free. Shelf stock at a pickup-only chain is not a
// checkout race, so the floor keeps a misconfigured interval from becoming a credit sink.
const STORE_ENRICH_DEFAULT = 30 * 60 * 1000;
const STORE_ENRICH_FLOOR = 10 * 60 * 1000;
// Enough to name the nearest store and count the rest without bloating every Redis row.
// Keep every store that actually HAS stock, not a display-sized sample.
//
// This was 5, and the embed's "+N other stores in stock" is derived from what is kept — so a
// product in stock at 16 stores advertised "+4". Understating is still a wrong number, and the
// standard here is that a wrong value is worse than a missing one.
//
// It was then 40, which was still short: on 2026-09-09 the Pitch Black Sleeved Booster was in
// stock at 69 stores and the embed advertised "+39 other stores". The cap is a sanity bound
// against a pathological response, not a display limit, so the honest bound is the number of
// stores that exist — past that, a response is malformed rather than merely large.
const STORE_ROWS_KEPT = storeAvail.ALL_LOCATION_CODES.length;

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

// Forms that are sealed product no matter what accessory word also appears in the title.
//
// "Sleeved Booster Pack" is a booster pack — sealed cards, exactly the drop people wait for —
// but the word "sleeved" matched the card-sleeves exclusion and silently removed it. London
// Drugs listed four of them (Mega Evolution Chaos Rising, Perfect Order, Mega Evolution
// Assorted, Destined Rivals) and this monitor tracked none. An exclusion list that can veto a
// product form is how real stock goes missing, so the form wins.
const SEALED_FORMS = ['booster pack', 'booster bundle', 'booster box', 'booster'];

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
  // A sealed form beats the accessory list. Checked first because the exclusion is a heuristic
  // over words in a title, and the form is the actual product: "Sleeved Booster Pack" is a
  // booster pack, not sleeves. Getting this the other way round dropped four real Pokemon
  // products from this store without a trace.
  if (SEALED_FORMS.some((f) => t.includes(f))) return true;
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
        image: `${IMAGE_BASE}/${p.productCode}.jpg`,
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
   * Never awaited by the poll: it is one request per tracked product, so it lags the stock number
   * by up to one interval. Acceptable only because London Drugs is pickup-only and therefore not
   * a checkout race.
   *
   * This used to drive a Next.js server action through a Bright Data browser session (~22s to
   * open, billed per GB). That path is gone, and it had been failing silently: the action id it
   * stored no longer exists in the store bundles. A plain GET carrying the PLURAL locationCodes
   * parameter returns the same per-store numbers, for all 78 stores rather than the first 50.
   */
  _maybeEnrichStores() {
    const due = Date.now() - this._storesAt >= this.storeEnrichIntervalMs;
    if (!due || this._storesRunning) return;
    if (!scraperApi.isConfigured()) return;   // no transport — alerts simply omit the store

    // EVERY listed product, not just the online-in-stock ones. The old pass filtered on
    // `p.inStock && p.url`, which is exactly backwards for shelf stock: London Drugs is
    // pickup-only, and a product can read 0 online while sitting on shelves — which is exactly
    // the case a buyer needs told about.
    const targets = [...this._known.values()].filter((p) => p && p.sku).map((p) => p.sku);
    if (targets.length === 0) return;         // catalogue still empty — try again next poll

    this._storesRunning = true;
    this._storesAt = Date.now();

    const fetcher = (url) => scraperApi.scraperFetch(url, {
      ...SCRAPER_OPTS, retailerId: this.id, minIntervalMs: 0, timeoutMs: 45000,
    });

    (async () => {
      let kept = 0;
      let failed = 0;
      for (const sku of targets) {
        const rows = await storeAvail.fetchInventory(sku, { fetcher });
        // [] means the lookup failed OR the product genuinely has no stock anywhere, and those
        // must not be treated alike: overwriting on failure would drop every store from the
        // alert the moment one request 403s. Only a response we actually parsed rewrites state.
        if (rows.length === 0) { failed++; continue; }
        const withStock = storeAvail.storesWithStock(rows).slice(0, STORE_ROWS_KEPT);
        if (withStock.length) { this._stores.set(sku, withStock); kept++; }
        else this._stores.delete(sku);
        await sleep(250 + Math.floor(Math.random() * 250));
      }
      logger.info(`${this.name}: store stock kept for ${kept}/${targets.length} product(s)`
        + (failed ? ` (${failed} lookup(s) returned nothing)` : ''));
      await this._saveStores();
    })()
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
    let inStoreOnly = 0;
    for (const p of found) {
      const stores = this._stores.get(p.sku);
      if (!stores || !stores.length) continue;
      p._stores = stores;
      attached++;

      // Shelf stock decides availability, not the website.
      //
      // `isAvailable` is an ONLINE flag, and London Drugs does not ship TCG — every item is
      // pickup-only. So a product can read isAvailable:false while sitting on shelves and being
      // perfectly buyable today, and we were reporting those as out of stock and saying nothing.
      // Measured 2026-09-09: 8 of 25 tracked products were in that state, including the Pitch
      // Black Elite Trainer Box with 41 units across 2 stores. Being able to walk in and buy it
      // is the whole point of tracking a pickup-only retailer.
      const units = storeAvail.totalUnits(stores);
      if (units > 0) {
        if (!p.inStock) inStoreOnly++;
        p.inStock = true;
        // The number a buyer can act on. `stockCount` is onlineStockLevel, which understates
        // shelf reality by 2x-58x here — it read "Stock: 2" against 117 units in 12 stores.
        p._stockQty = units;
      }
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
    logger.info(`${this.name}: FAST — ${found.length} tracked products (${inStock} in stock`
      + `${inStoreOnly ? `, ${inStoreOnly} in stores only` : ''}), ${Date.now() - start}ms`);

    return Object.fromEntries(this._known);
  }
}

module.exports = LondonDrugsAdapter;
module.exports.parseFlightProducts = parseFlightProducts;
module.exports.isTrackedCardProduct = isTrackedCardProduct;
module.exports.slugMap = slugMap;
module.exports.decodeEntities = decodeEntities;
