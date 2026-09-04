const fs = require('fs');
const path = require('path');
const state = require('../core/state');
const logger = require('../monitoring/logger');

const retailersPath = path.join(__dirname, '../config/retailers.json');

// Stale threshold: 3x the adapter's polling interval (min 5 min, max 30 min)
// This prevents false STALE alerts for slow-polling adapters like Pokemon Center (5 min interval)
const MIN_STALE_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 30 * 60 * 1000;
function getStaleThreshold(retailer) {
  const interval = retailer.intervalMs || 60000;
  return Math.max(MIN_STALE_MS, Math.min(interval * 3, MAX_STALE_MS));
}

// Adapter health: track consecutive 0-product polls (#4)
// Threshold 6 accounts for ScraperAPI rate limiting (5-min intervals) — adapters
// polling every 60s will have ~5 rate-limited polls between successful ones
const zeroProductPolls = new Map(); // retailerId → consecutive count
const ZERO_PRODUCT_THRESHOLD = 6;

// Detection health: an adapter can return a full product list built entirely from cache
// while every live check fails. Counting those polls as healthy is how Pokemon Center hid
// a day of total failure behind "found 500 products".
const zeroFreshPolls = new Map(); // retailerId → consecutive polls that fetched nothing live
const ZERO_FRESH_THRESHOLD = 3;

async function checkHealth() {
  // Merge base config with Redis overrides so enabled state is accurate
  const base = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const overrides = await state.getRetailerOverrides();
  const retailers = base.map(r => ({ ...r, ...(overrides[r.id] || {}) }));

  const results = [];

  for (const retailer of retailers) {
    if (!retailer.enabled) continue;

    const status = await state.getRetailerStatus(retailer.id);
    const lastCheck = await state.getLastCheck(retailer.id);
    const now = Date.now();

    const staleThreshold = getStaleThreshold(retailer);
    const isStale = lastCheck && (now - lastCheck) > staleThreshold;
    const zeroCount = zeroProductPolls.get(retailer.id) || 0;
    const staleDataCount = zeroFreshPolls.get(retailer.id) || 0;
    const quality = parseQuality.get(retailer.id) || { emptyPolls: 0, lastRatio: null };
    const healthy = status.healthy && !isStale
      && zeroCount < ZERO_PRODUCT_THRESHOLD
      && staleDataCount < ZERO_FRESH_THRESHOLD
      && quality.emptyPolls < QUALITY_THRESHOLD;

    results.push({
      id: retailer.id,
      name: retailer.name,
      healthy,
      stale: isStale,
      lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
      consecutiveErrors: status.errors,
      lastError: status.lastError,
      zeroProductPolls: zeroCount,
      zeroFreshPolls: staleDataCount,
      servingStaleData: staleDataCount >= ZERO_FRESH_THRESHOLD,
      pricedRatio: quality.lastRatio,
      parserSuspect: quality.emptyPolls >= QUALITY_THRESHOLD,
    });
  }

  return results;
}

async function isSystemHealthy() {
  const results = await checkHealth();
  const unhealthyCount = results.filter(r => !r.healthy).length;
  return {
    healthy: unhealthyCount === 0,
    unhealthyCount,
    total: results.length,
    retailers: results,
  };
}

// Redis health check (#3)
async function checkRedisHealth() {
  try {
    const redis = state.getRedis();
    const pong = await redis.ping();
    return { healthy: pong === 'PONG', latencyMs: 0 };
  } catch (err) {
    logger.error(`Redis health check failed: ${err.message}`);
    return { healthy: false, error: err.message };
  }
}

// Called by scheduler after each successful poll
function recordProductCount(retailerId, count) {
  if (count === 0) {
    const prev = zeroProductPolls.get(retailerId) || 0;
    zeroProductPolls.set(retailerId, prev + 1);
    if (prev + 1 >= ZERO_PRODUCT_THRESHOLD) {
      logger.warn(`ADAPTER HEALTH: ${retailerId} returned 0 products for ${prev + 1} consecutive polls`);
    }
  } else {
    zeroProductPolls.set(retailerId, 0);
  }
}

// Parse-quality canary. A broken parser rarely returns nothing — it returns the right
// number of products with the fields emptied out (null prices, everything out of stock).
// Product count alone cannot see that, so we watch the shape of the result instead.
const parseQuality = new Map(); // retailerId → { emptyPolls, lastRatio }
const MIN_SAMPLE = 10;          // below this a poll is too small to judge
const PRICE_RATIO_FLOOR = 0.2;  // healthy adapters sit far above this
const QUALITY_THRESHOLD = 3;    // consecutive bad polls before we call it broken

/**
 * @param {object} products - the poll's product map, post-cap
 * @param {boolean} enabled - false for adapters whose catalogue legitimately lacks prices
 */
function recordParseQuality(retailerId, products, enabled = true) {
  // Pokemon Center publishes a 1,195-product sitemap but can only price the handful it
  // pays to check, so a zero priced-ratio there is correct, not a regression.
  if (!enabled) return;
  const values = Object.values(products || {});
  if (values.length < MIN_SAMPLE) return; // not enough to judge — stay silent

  const withPrice = values.filter(p => p && typeof p.price === 'number' && p.price > 0).length;
  const ratio = withPrice / values.length;
  const entry = parseQuality.get(retailerId) || { emptyPolls: 0, lastRatio: null };
  entry.lastRatio = parseFloat(ratio.toFixed(3));

  if (ratio >= PRICE_RATIO_FLOOR) {
    if (entry.emptyPolls >= QUALITY_THRESHOLD) {
      logger.info(`ADAPTER HEALTH: ${retailerId} parse quality recovered (${withPrice}/${values.length} priced)`);
    }
    entry.emptyPolls = 0;
  } else {
    entry.emptyPolls++;
    if (entry.emptyPolls === QUALITY_THRESHOLD) {
      logger.error(`ADAPTER HEALTH: ${retailerId} returned ${values.length} products but only ${withPrice} had a price, ${entry.emptyPolls} polls running — parser is probably broken`);
    }
  }
  parseQuality.set(retailerId, entry);
}

function getParseQuality() {
  const out = {};
  for (const [id, e] of parseQuality) {
    if (e.emptyPolls > 0) out[id] = { badPolls: e.emptyPolls, pricedRatio: e.lastRatio };
  }
  return out;
}

/**
 * Called after each poll by adapters that distinguish live data from cache.
 * attempted === 0 means nothing was due this poll — neutral, not a failure.
 */
function recordFreshness(retailerId, fresh, attempted) {
  if (!attempted || attempted <= 0) return;
  if (fresh > 0) {
    if ((zeroFreshPolls.get(retailerId) || 0) >= ZERO_FRESH_THRESHOLD) {
      logger.info(`ADAPTER HEALTH: ${retailerId} is fetching live data again`);
    }
    zeroFreshPolls.set(retailerId, 0);
    return;
  }
  const next = (zeroFreshPolls.get(retailerId) || 0) + 1;
  zeroFreshPolls.set(retailerId, next);
  if (next === ZERO_FRESH_THRESHOLD) {
    logger.error(`ADAPTER HEALTH: ${retailerId} has served only cached data for ${next} consecutive polls (0/${attempted} live) — detection is DOWN even though polls succeed`);
  }
}

function getZeroFreshPolls() {
  const result = {};
  for (const [id, count] of zeroFreshPolls) {
    if (count > 0) result[id] = count;
  }
  return result;
}

function getZeroProductPolls() {
  const result = {};
  for (const [id, count] of zeroProductPolls) {
    if (count > 0) result[id] = count;
  }
  return result;
}

module.exports = {
  checkHealth, isSystemHealthy, checkRedisHealth,
  recordProductCount, getZeroProductPolls,
  recordFreshness, getZeroFreshPolls,
  recordParseQuality, getParseQuality,
};
