const fs = require('fs');
const path = require('path');
const state = require('../core/state');
const logger = require('../monitoring/logger');

const retailersPath = path.join(__dirname, '../config/retailers.json');
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes without check = stale

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
