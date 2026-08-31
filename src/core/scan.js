const fs = require('fs');
const path = require('path');
const state = require('./state');
const { EVENT_TYPES } = require('./events');
const delivery = require('../discord/delivery');
const logger = require('../monitoring/logger');

const retailersPath = path.join(__dirname, '../config/retailers.json');

let scanning = false;

async function runScan(hoursBack = 12) {
  if (scanning) {
    throw new Error('A scan is already in progress');
  }

  scanning = true;
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const results = { totalProducts: 0, totalSent: 0, retailers: [] };

  try {
    const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
    const enabled = retailers.filter(r => r.enabled);

    for (const retailer of enabled) {
      const products = await state.getAllProducts(retailer.id);
      const entries = Object.values(products);

      // Filter to products seen within the time window
      const recent = entries.filter(p => p.lastSeen && p.lastSeen >= cutoff);

      if (recent.length === 0) {
        results.retailers.push({ retailer: retailer.id, name: retailer.name, found: entries.length, sent: 0 });
        continue;
      }

      // Build LISTING events
      const events = recent.map(product => ({
        type: EVENT_TYPES.LISTING,
        product: {
          ...product,
          retailerId: retailer.id,
        },
        detail: 'Manual scan — currently listed',
        _scanTier: 'scan',
      }));

      await delivery.deliver(events, { skipDedup: true });

      results.totalProducts += recent.length;
      results.totalSent += recent.length;
      results.retailers.push({ retailer: retailer.id, name: retailer.name, found: entries.length, sent: recent.length });

      logger.info(`Scan: ${retailer.name} — ${recent.length}/${entries.length} products within ${hoursBack}h window`);
    }

    logger.info(`Scan complete: ${results.totalSent} products sent across ${results.retailers.length} retailers`);
    return results;
  } finally {
    scanning = false;
  }
}

function isScanning() {
  return scanning;
}

module.exports = { runScan, isScanning };
