const state = require('../core/state');
const logger = require('../monitoring/logger');

const PREFIX = 'tcg:dedup:';
const DEDUP_TTL = 600; // 10 minutes — allows legitimate rapid restocks (P1-3)
// Drop waves arrive minutes apart; the 10-minute window would swallow every wave after the first
const WATCHLIST_RESTOCK_TTL = 45;

function ttlFor(event) {
  return event.type === 'RESTOCK' && event.product?._watchlist ? WATCHLIST_RESTOCK_TTL : DEDUP_TTL;
}

// In-memory fallback dedup when Redis is unavailable
const memoryDedup = new Map();
const MEMORY_MAX_SIZE = 5000;

function eventKey(event) {
  const { type, product } = event;
  // Include stock state so OOS→restock→OOS→restock generates unique keys
  const stateHash = type === 'RESTOCK' ? `:${product.inStock ? '1' : '0'}` : '';
  return `${PREFIX}${type}:${product.retailer}:${product.sku}${stateHash}`;
}

function isMemoryDuplicate(key) {
  const entry = memoryDedup.get(key);
  if (!entry) return false;
  if (Date.now() > entry) {
    memoryDedup.delete(key);
    return false;
  }
  return true;
}

function markMemory(key, ttl) {
  // Evict oldest entries if cache is full
  if (memoryDedup.size >= MEMORY_MAX_SIZE) {
    const oldest = memoryDedup.keys().next().value;
    memoryDedup.delete(oldest);
  }
  memoryDedup.set(key, Date.now() + ttl * 1000);
}

async function isDuplicate(event) {
  const key = eventKey(event);
  const existing = await state.getRedis().get(key);
  return !!existing;
}

async function markSent(event) {
  const key = eventKey(event);
  const ttl = ttlFor(event);
  await state.getRedis().set(key, '1', 'EX', ttl);
  // Also mark in memory so fallback stays in sync
  markMemory(key, ttl);
}

async function filterDuplicates(events) {
  const unique = [];
  for (const event of events) {
    const key = eventKey(event);
    try {
      if (await isDuplicate(event)) {
        logger.debug(`Dedup: skipping ${event.type} for ${event.product.sku}`);
        continue;
      }
    } catch (err) {
      // Redis is down — use in-memory fallback instead of failing open
      logger.warn(`Dedup: Redis error, using memory fallback: ${err.message}`);
      if (isMemoryDuplicate(key)) {
        logger.debug(`Dedup: memory fallback skipping ${event.type} for ${event.product.sku}`);
        continue;
      }
      markMemory(key, ttlFor(event));
    }
    unique.push(event);
  }
  return unique;
}

module.exports = { isDuplicate, markSent, filterDuplicates };
