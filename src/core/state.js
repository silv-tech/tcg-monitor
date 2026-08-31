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

async function getProduct(retailerId, sku) {
  const key = `${PREFIX}product:${hashSku(retailerId, sku)}`;
  const data = await getRedis().get(key);
  return data ? JSON.parse(data) : null;
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
    const [nextCursor, batch] = await getRedis().scan(cursor, 'MATCH', pattern, 'COUNT', 200);
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
      const p = JSON.parse(data);
      products[p.sku] = p;
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
  return data ? JSON.parse(data) : { errors: 0, lastError: null, healthy: true };
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
  return data ? JSON.parse(data) : {};
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
  return data ? JSON.parse(data) : null;
}

async function setChannelsConfig(config) {
  await getRedis().set(CHANNELS_KEY, JSON.stringify(config));
}

// ─── Products config persistence ─────────────────────────────────
async function getProductsConfig() {
  const data = await getRedis().get(PRODUCTS_KEY);
  return data ? JSON.parse(data) : null;
}

async function setProductsConfig(config) {
  await getRedis().set(PRODUCTS_KEY, JSON.stringify(config));
}

async function shutdown() {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

module.exports = {
  getRedis,
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
  shutdown,
};
