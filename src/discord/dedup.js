const state = require('../core/state');
const logger = require('../monitoring/logger');

const PREFIX = 'tcg:dedup:';
const DEDUP_TTL = 600; // 10 minutes — allows legitimate rapid restocks (P1-3)
// Drop waves arrive minutes apart; the 10-minute window would swallow every wave after the first
const WATCHLIST_RESTOCK_TTL = 45;

/**
 * How long the SAME price transition stays suppressed.
 *
 * A marketplace buy box flaps between sellers, so the price oscillates between two values
 * and every swing back down re-presents an identical "drop". Keyed only on the SKU with a
 * 10-minute window, that re-fires up to six times an hour indefinitely: B0GX7S11S3 sent the
 * identical "$24.97 -> $17.45 (-30%)" 21 times on 2026-09-05 before the limiter muted Amazon.
 *
 * A drop to a price we have not already reported is still a new key and still alerts at once,
 * so this suppresses repetition, never news.
 */
const REPEAT_PRICE_TTL = 6 * 60 * 60; // 6 hours

// In-memory fallback dedup when Redis is unavailable
const memoryDedup = new Map();
const MEMORY_MAX_SIZE = 5000;

/**
 * Every gate an event has to clear, as [key, ttl] pairs. An event is a duplicate if ANY
 * gate already holds, and sending it sets all of them.
 */
function eventKeys(event) {
  const { type, product } = event;
  const base = `${PREFIX}${type}:${product.retailer}:${product.sku}`;

  if (type === 'RESTOCK') {
    // Include stock state so OOS→restock→OOS→restock generates unique keys
    const ttl = product?._watchlist ? WATCHLIST_RESTOCK_TTL : DEDUP_TTL;
    return [[`${base}:${product.inStock ? '1' : '0'}`, ttl]];
  }

  if (type === 'PRICE_CHANGE' && event.oldValue != null && event.newValue != null) {
    return [
      // Unchanged short window: any second price move for this SKU right after the first.
      [base, DEDUP_TTL],
      // Long window on the exact transition, which is what a flapping buy box repeats.
      [`${base}:${event.oldValue}>${event.newValue}`, REPEAT_PRICE_TTL],
    ];
  }

  return [[base, DEDUP_TTL]];
}

/** Kept for callers that only need the primary key. */
function eventKey(event) {
  return eventKeys(event)[0][0];
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
  const redis = state.getRedis();
  for (const [key] of eventKeys(event)) {
    if (await redis.get(key)) return true;
  }
  return false;
}

async function markSent(event) {
  const redis = state.getRedis();
  for (const [key, ttl] of eventKeys(event)) {
    await redis.set(key, '1', 'EX', ttl);
    // Also mark in memory so fallback stays in sync
    markMemory(key, ttl);
  }
}

async function filterDuplicates(events) {
  const unique = [];
  for (const event of events) {
    const keys = eventKeys(event);
    try {
      if (await isDuplicate(event)) {
        logger.debug(`Dedup: skipping ${event.type} for ${event.product.sku}`);
        continue;
      }
    } catch (err) {
      // Redis is down — use in-memory fallback instead of failing open
      logger.warn(`Dedup: Redis error, using memory fallback: ${err.message}`);
      if (keys.some(([key]) => isMemoryDuplicate(key))) {
        logger.debug(`Dedup: memory fallback skipping ${event.type} for ${event.product.sku}`);
        continue;
      }
      for (const [key, ttl] of keys) markMemory(key, ttl);
    }
    unique.push(event);
  }
  return unique;
}

module.exports = { isDuplicate, markSent, filterDuplicates, eventKey, eventKeys, REPEAT_PRICE_TTL };
