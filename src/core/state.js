const Redis = require('ioredis');
const config = require('../config');
const logger = require('../monitoring/logger');
const { hashSku } = require('../utils/helpers');

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true, // P2-2: queue commands during disconnect instead of throwing
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
    redis.on('connect', () => logger.info('Redis connected'));
  }
  return redis;
}

const PREFIX = 'tcg:';
const SKU_TTL = 86400 * 7; // 7 days

// Safe JSON.parse — corrupted Redis data should never crash the process
function safeParse(data, fallback = null) {
  try { return JSON.parse(data); }
  catch (err) { logger.warn(`Corrupted Redis data, returning fallback: ${err.message}`); return fallback; }
}

async function getProduct(retailerId, sku) {
  const key = `${PREFIX}product:${hashSku(retailerId, sku)}`;
  const data = await getRedis().get(key);
  return data ? safeParse(data) : null;
}

async function setProduct(retailerId, sku, product) {
  const key = `${PREFIX}product:${hashSku(retailerId, sku)}`;
  await getRedis().set(key, JSON.stringify(product), 'EX', SKU_TTL);
}

async function deleteProduct(retailerId, sku) {
  const key = `${PREFIX}product:${hashSku(retailerId, sku)}`;
  await getRedis().del(key);
}

async function getAllProducts(retailerId) {
  const pattern = `${PREFIX}product:${retailerId}:*`;
  // P2-3: Use SCAN instead of KEYS to avoid blocking Redis on large keyspaces
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await getRedis().scan(cursor, 'MATCH', pattern, 'COUNT', 5000);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  if (!keys.length) return {};
  const pipeline = getRedis().pipeline();
  keys.forEach(k => pipeline.get(k));
  const results = await pipeline.exec();
  const products = {};
  results.forEach(([err, data]) => {
    if (!err && data) {
      const p = safeParse(data);
      if (p && p.sku) products[p.sku] = p;
    }
  });
  return products;
}

async function getLastCheck(retailerId) {
  const key = `${PREFIX}lastcheck:${retailerId}`;
  const ts = await getRedis().get(key);
  return ts ? parseInt(ts) : null;
}

async function setLastCheck(retailerId) {
  const key = `${PREFIX}lastcheck:${retailerId}`;
  await getRedis().set(key, Date.now().toString(), 'EX', 86400);
}

async function getRetailerStatus(retailerId) {
  const key = `${PREFIX}status:${retailerId}`;
  const data = await getRedis().get(key);
  return data ? safeParse(data, { errors: 0, lastError: null, healthy: true }) : { errors: 0, lastError: null, healthy: true };
}

async function setRetailerStatus(retailerId, status) {
  const key = `${PREFIX}status:${retailerId}`;
  await getRedis().set(key, JSON.stringify(status), 'EX', 86400);
}

async function recordError(retailerId, error) {
  const status = await getRetailerStatus(retailerId);
  status.errors++;
  status.lastError = { message: error.message, time: Date.now() };
  if (status.errors >= 5) status.healthy = false;
  await setRetailerStatus(retailerId, status);
  return status;
}

async function clearErrors(retailerId) {
  await setRetailerStatus(retailerId, { errors: 0, lastError: null, healthy: true });
}

// ─── Config persistence (survive ephemeral filesystem deploys) ────
const OVERRIDES_KEY = `${PREFIX}retailer_overrides`;
const CHANNELS_KEY = `${PREFIX}channels_config`;
const PRODUCTS_KEY = `${PREFIX}products_config`;

async function getRetailerOverrides() {
  const data = await getRedis().get(OVERRIDES_KEY);
  return data ? safeParse(data, {}) : {};
}

async function setRetailerOverride(retailerId, changes) {
  const overrides = await getRetailerOverrides();
  overrides[retailerId] = { ...(overrides[retailerId] || {}), ...changes };
  await getRedis().set(OVERRIDES_KEY, JSON.stringify(overrides));
}

async function deleteRetailerOverride(retailerId) {
  const overrides = await getRetailerOverrides();
  delete overrides[retailerId];
  await getRedis().set(OVERRIDES_KEY, JSON.stringify(overrides));
}

// ─── Channels config persistence ─────────────────────────────────
async function getChannelsConfig() {
  const data = await getRedis().get(CHANNELS_KEY);
  return data ? safeParse(data) : null;
}

async function setChannelsConfig(config) {
  await getRedis().set(CHANNELS_KEY, JSON.stringify(config));
}

// ─── Products config persistence ─────────────────────────────────
async function getProductsConfig() {
  const data = await getRedis().get(PRODUCTS_KEY);
  return data ? safeParse(data) : null;
}

async function setProductsConfig(config) {
  await getRedis().set(PRODUCTS_KEY, JSON.stringify(config));
}

// ─── Restock history ─────────────────────────────────────────────
const RESTOCK_TTL = 86400 * 90; // 90 days
const RESTOCK_MAX = 10;

async function recordRestock(retailerId, sku) {
  const key = `${PREFIX}restock:${retailerId}:${sku}`;
  const raw = await getRedis().get(key);
  const history = raw ? safeParse(raw, []) : [];
  history.push(Date.now());
  if (history.length > RESTOCK_MAX) history.splice(0, history.length - RESTOCK_MAX);
  await getRedis().set(key, JSON.stringify(history), 'EX', RESTOCK_TTL);
}

async function getRestockHistory(retailerId, sku) {
  const key = `${PREFIX}restock:${retailerId}:${sku}`;
  const raw = await getRedis().get(key);
  return raw ? safeParse(raw, []) : [];
}

// ─── Cross-retailer price check (#8, #14) ───────────────────────
// In-memory index rebuilt from Redis on each poll cycle — avoids SCAN on every alert
const crossRetailerIndex = []; // [{ retailerId, sku, name, tokens, price, url, asin }]
let indexLastBuilt = 0;
// Polls keep the index current via setRetailerIndex; the full Redis rebuild is only a safety net
const INDEX_TTL = 15 * 60000;

function indexEntry(retailerId, p) {
  return {
    retailerId,
    sku: p.sku,
    name: p.name || '',
    tokens: tokenize(p.name || ''),
    price: p.price,
    url: p.url,
    asin: retailerId === 'amazon' ? p.sku : null,
  };
}

// Replace one retailer's entries straight from its latest poll — no Redis reads
function setRetailerIndex(retailerId, products) {
  const kept = crossRetailerIndex.filter(e => e.retailerId !== retailerId);
  crossRetailerIndex.length = 0;
  for (const e of kept) crossRetailerIndex.push(e);
  for (const p of Object.values(products)) {
    if (!p || !p.inStock || p.price == null || p.price <= 0) continue;
    crossRetailerIndex.push(indexEntry(retailerId, p));
  }
  if (indexLastBuilt === 0) indexLastBuilt = Date.now();
}

function tokenize(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1);
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

async function rebuildCrossRetailerIndex() {
  const now = Date.now();
  const pattern = `${PREFIX}product:*`;
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await getRedis().scan(cursor, 'MATCH', pattern, 'COUNT', 5000);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');

  if (!keys.length) { indexLastBuilt = now; return; }

  const pipeline = getRedis().pipeline();
  keys.forEach(k => pipeline.get(k));
  const results = await pipeline.exec();

  crossRetailerIndex.length = 0;
  const MAX_INDEX_SIZE = 20000;
  for (const [err, data] of results) {
    if (err || !data) continue;
    const p = safeParse(data);
    if (!p || !p.inStock || p.price == null || p.price <= 0) continue;
    crossRetailerIndex.push(indexEntry(p.retailerId, p));
    if (crossRetailerIndex.length >= MAX_INDEX_SIZE) break;
  }
  indexLastBuilt = now;
}

let indexRefreshing = null;
function refreshCrossRetailerIndex() {
  if (!indexRefreshing) {
    indexRefreshing = rebuildCrossRetailerIndex()
      .catch(() => {})
      .finally(() => { indexRefreshing = null; });
  }
  return indexRefreshing;
}

// Keeps the index warm so alerts never wait on a full product scan
function startCrossRetailerIndexRefresh() {
  refreshCrossRetailerIndex();
  setInterval(refreshCrossRetailerIndex, INDEX_TTL).unref();
}

async function findCrossRetailerMatches(product) {
  // Only the very first lookup blocks on a build; a stale index refreshes in the background
  if (indexLastBuilt === 0) await refreshCrossRetailerIndex();
  else if (Date.now() - indexLastBuilt >= INDEX_TTL) refreshCrossRetailerIndex();

  const sourceTokens = tokenize(product.name || '');
  if (!sourceTokens.length && !product.sku) return [];

  const matches = [];
  for (const p of crossRetailerIndex) {
    if (p.retailerId === product.retailerId) continue;

    // #8: Exact ASIN match first (Amazon products across .ca/.com)
    if (product.sku && p.asin && product.sku === p.asin) {
      matches.push({ retailer: p.retailerId, price: p.price, url: p.url, similarity: 1.0 });
      continue;
    }

    // Jaccard name similarity
    if (sourceTokens.length > 0) {
      const sim = jaccardSimilarity(sourceTokens, p.tokens);
      if (sim >= 0.4) {
        matches.push({ retailer: p.retailerId, price: p.price, url: p.url, similarity: sim });
      }
    }
  }

  // One entry per retailer. Without this the same store could occupy every slot — a real
  // alert showed "rivalcards - $54.95 | rivalcards - $59.95 | chimeragaming - $34.00", which
  // wastes two of the three slots and reads like a bug to anyone looking at it. Keep each
  // retailer's best match: highest similarity, and on a tie the cheaper listing.
  matches.sort((a, b) => (b.similarity - a.similarity) || (a.price - b.price));
  const bestPerRetailer = new Map();
  for (const m of matches) {
    if (!bestPerRetailer.has(m.retailer)) bestPerRetailer.set(m.retailer, m);
  }
  return [...bestPerRetailer.values()].slice(0, 3);
}

// ─── Price history (#12) ──────────────────────────��───────────────
const PRICE_HISTORY_TTL = 86400 * 90; // 90 days
const PRICE_HISTORY_MAX = 10;

async function recordPrice(retailerId, sku, price) {
  if (price == null || price <= 0) return;
  const key = `${PREFIX}pricehistory:${retailerId}:${sku}`;
  const raw = await getRedis().get(key);
  const history = raw ? safeParse(raw, []) : [];
  // Only record if price changed from last entry
  if (history.length > 0 && history[history.length - 1].price === price) return;
  history.push({ price, time: Date.now() });
  if (history.length > PRICE_HISTORY_MAX) history.splice(0, history.length - PRICE_HISTORY_MAX);
  await getRedis().set(key, JSON.stringify(history), 'EX', PRICE_HISTORY_TTL);
}

async function getPriceHistory(retailerId, sku) {
  const key = `${PREFIX}pricehistory:${retailerId}:${sku}`;
  const raw = await getRedis().get(key);
  return raw ? safeParse(raw, []) : [];
}

// ─── Amazon Offer Listing ID cache ──────────────────────────────
const OLID_TTL = 86400 * 30; // 30 days — OLIDs rarely change for same seller

async function getOfferListingId(asin) {
  const key = `${PREFIX}olid:${asin}`;
  return await getRedis().get(key);
}

async function cacheOfferListingId(asin, olid) {
  if (!olid) return;
  const key = `${PREFIX}olid:${asin}`;
  await getRedis().set(key, olid, 'EX', OLID_TTL);
}

// ─── Amazon seller cache ────────────────────────────────────────
const SELLER_TTL = 86400 * 30; // 30 days — same as OLID

async function getSellerCache(asin) {
  const key = `${PREFIX}seller:${asin}`;
  return await getRedis().get(key);
}

async function cacheSellerInfo(asin, seller) {
  if (!seller) return;
  const key = `${PREFIX}seller:${asin}`;
  await getRedis().set(key, seller, 'EX', SELLER_TTL);
}

// ─── Early detection keywords ────────────────────────────────────
const EARLY_KEYWORDS_KEY = `${PREFIX}early_keywords`;

async function getEarlyKeywords() {
  const data = await getRedis().get(EARLY_KEYWORDS_KEY);
  return data ? safeParse(data, []) : [];
}

async function addEarlyKeyword(keyword) {
  const keywords = await getEarlyKeywords();
  const lower = keyword.toLowerCase().trim();
  if (keywords.includes(lower)) return false;
  keywords.push(lower);
  await getRedis().set(EARLY_KEYWORDS_KEY, JSON.stringify(keywords));
  return true;
}

async function removeEarlyKeyword(keyword) {
  const keywords = await getEarlyKeywords();
  const lower = keyword.toLowerCase().trim();
  const idx = keywords.indexOf(lower);
  if (idx === -1) return false;
  keywords.splice(idx, 1);
  await getRedis().set(EARLY_KEYWORDS_KEY, JSON.stringify(keywords));
  return true;
}

// ─── Active categories (toggle which TCG games trigger alerts) ───
const ACTIVE_CATEGORIES_KEY = `${PREFIX}active_categories`;
const ALL_CATEGORIES = ['pokemon', 'onepiece', 'dragonball', 'naruto', 'lorcana', 'yugioh', 'mtg'];

async function getActiveCategories() {
  const data = await getRedis().get(ACTIVE_CATEGORIES_KEY);
  if (!data) return [...ALL_CATEGORIES]; // all enabled by default
  return safeParse(data, [...ALL_CATEGORIES]);
}

async function setActiveCategories(categories) {
  await getRedis().set(ACTIVE_CATEGORIES_KEY, JSON.stringify(categories));
}

function getAllCategories() {
  return [...ALL_CATEGORIES];
}

// ─── Per-store category overrides ────────────────────────────────
const STORE_CATEGORIES_PREFIX = `${PREFIX}store_categories:`;

async function getStoreCategories(retailerId) {
  const data = await getRedis().get(`${STORE_CATEGORIES_PREFIX}${retailerId}`);
  return data ? safeParse(data, null) : null; // null = use global
}

async function setStoreCategories(retailerId, categories) {
  await getRedis().set(`${STORE_CATEGORIES_PREFIX}${retailerId}`, JSON.stringify(categories));
}

async function clearStoreCategories(retailerId) {
  await getRedis().del(`${STORE_CATEGORIES_PREFIX}${retailerId}`);
}

async function getAllStoreOverrides() {
  const keys = await getRedis().keys(`${STORE_CATEGORIES_PREFIX}*`);
  const overrides = {};
  for (const key of keys) {
    const retailerId = key.replace(STORE_CATEGORIES_PREFIX, '');
    const data = await getRedis().get(key);
    if (data) overrides[retailerId] = safeParse(data, null);
  }
  return overrides;
}

// ─── Watchlist persistence (survive deploys) ─────────────────────
const WATCHLIST_KEY = `${PREFIX}watchlist_overrides`;

async function getWatchlistOverrides() {
  const data = await getRedis().get(WATCHLIST_KEY);
  return data ? safeParse(data, {}) : {};
}

async function setWatchlistOverride(retailerId, skus) {
  const overrides = await getWatchlistOverrides();
  overrides[retailerId] = skus;
  await getRedis().set(WATCHLIST_KEY, JSON.stringify(overrides));
}

async function shutdown() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

module.exports = {
  getRedis,
  startCrossRetailerIndexRefresh,
  setRetailerIndex,
  getProduct,
  setProduct,
  deleteProduct,
  getAllProducts,
  getLastCheck,
  setLastCheck,
  getRetailerStatus,
  setRetailerStatus,
  recordError,
  clearErrors,
  getRetailerOverrides,
  setRetailerOverride,
  deleteRetailerOverride,
  getChannelsConfig,
  setChannelsConfig,
  getProductsConfig,
  setProductsConfig,
  recordRestock,
  getRestockHistory,
  findCrossRetailerMatches,
  recordPrice,
  getPriceHistory,
  getOfferListingId,
  cacheOfferListingId,
  getSellerCache,
  cacheSellerInfo,
  getActiveCategories,
  setActiveCategories,
  getAllCategories,
  getStoreCategories,
  setStoreCategories,
  clearStoreCategories,
  getAllStoreOverrides,
  getWatchlistOverrides,
  setWatchlistOverride,
  getEarlyKeywords,
  addEarlyKeyword,
  removeEarlyKeyword,
  shutdown,
};
