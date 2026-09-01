const fs = require('fs');
const path = require('path');
const state = require('../core/state');
const logger = require('../monitoring/logger');

const retailersPath = path.join(__dirname, '../config/retailers.json');
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without check = stale

// Adapter health: track consecutive 0-product polls (#4)
// Threshold 6 accounts for ScraperAPI rate limiting (5-min intervals) — adapters
// polling every 60s will have ~5 rate-limited polls between successful ones
const zeroProductPolls = new Map(); // retailerId → consecutive count
const ZERO_PRODUCT_THRESHOLD = 6;

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

    const isStale = lastCheck && (now - lastCheck) > STALE_THRESHOLD_MS;
    const zeroCount = zeroProductPolls.get(retailer.id) || 0;
    const healthy = status.healthy && !isStale && zeroCount < ZERO_PRODUCT_THRESHOLD;

    results.push({
      id: retailer.id,
      name: retailer.name,
      healthy,
      stale: isStale,
      lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
      consecutiveErrors: status.errors,
      lastError: status.lastError,
      zeroProductPolls: zeroCount,
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

function getZeroProductPolls() {
  const result = {};
  for (const [id, count] of zeroProductPolls) {
    if (count > 0) result[id] = count;
  }
  return result;
}

module.exports = { checkHealth, isSystemHealthy, checkRedisHealth, recordProductCount, getZeroProductPolls };
