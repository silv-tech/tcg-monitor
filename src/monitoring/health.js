const state = require('../core/state');
const logger = require('../monitoring/logger');
const retailers = require('../config/retailers.json');

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without check = stale

async function checkHealth() {
  const results = [];

  for (const retailer of retailers) {
    if (!retailer.enabled) continue;

    const status = await state.getRetailerStatus(retailer.id);
    const lastCheck = await state.getLastCheck(retailer.id);
    const now = Date.now();

    const isStale = lastCheck && (now - lastCheck) > STALE_THRESHOLD_MS;
    const healthy = status.healthy && !isStale;

    results.push({
      id: retailer.id,
      name: retailer.name,
      healthy,
      stale: isStale,
      lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
      consecutiveErrors: status.errors,
      lastError: status.lastError,
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

module.exports = { checkHealth, isSystemHealthy };
