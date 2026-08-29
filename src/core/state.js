const Redis = require('ioredis');
const config = require('../config');
const logger = require('../monitoring/logger');
const { hashSku } = require('../utils/helpers');

let redis;

function getRedis() {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
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

async function getAllProducts(retailerId) {
  const pattern = `${PREFIX}product:${retailerId}:*`;
  const keys = await getRedis().keys(pattern);
  if (!keys.length) return {};
  const pipeline = getRedis().pipeline();
  keys.forEach(k => pipeline.get(k));
  const results = await pipeline.exec();
  const products = {};
  results.forEach(([err, data], i) => {
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
  getAllProducts,
  getLastCheck,
  setLastCheck,
  getRetailerStatus,
  setRetailerStatus,
  recordError,
  clearErrors,
  shutdown,
};
