const logger = require('../monitoring/logger');
const state = require('./state');
const { diffProducts, EVENT_TYPES } = require('./events');
const { recordPollLatency } = require('./proxy');
const { recordProductCount, recordFreshness, recordParseQuality } = require('../monitoring/health');
const { hashSku } = require('../utils/helpers');

/**
 * Execute a single poll cycle for an adapter.
 * Extracted from Scheduler for testability and clarity (#22).
 *
 * @param {object} adapter - The adapter instance
 * @param {object} circuit - Circuit breaker state for this adapter
 * @param {function} onEvents - Event handler callback
 * @param {number} adapterTimeout - Max poll duration in ms
 * @returns {object} { success, productCount, eventCount, pollMs }
 */
async function pollAdapterOnce(adapter, circuit, onEvents, adapterTimeout) {
  const pollStart = Date.now();

  // Timeout wrapper (clear timer on completion to prevent leak)
  let timeoutHandle;
  const newProducts = await Promise.race([
    adapter.run().finally(() => clearTimeout(timeoutHandle)),
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Adapter timeout after ${adapterTimeout}ms`)), adapterTimeout);
    }),
  ]);
  const pollMs = Date.now() - pollStart;
  recordPollLatency(adapter.id, pollMs);

  const oldProducts = await state.getAllProducts(adapter.id);

  // Seed mode: first poll — cache products without firing events
  const isFirstPoll = Object.keys(oldProducts).length === 0 && Object.keys(newProducts).length > 0;
  if (isFirstPoll) {
    logger.info(`${adapter.name}: first poll — seeding ${Object.keys(newProducts).length} products (no alerts fired)`);
  }

  let eventCount = 0;
  if (!isFirstPoll) {
    const events = diffProducts(oldProducts, newProducts);

    if (events.length > 0) {
      const detectedAt = Date.now();
      for (const event of events) {
        event._detectedAt = detectedAt;
      }

      // Early keyword detection — check new/restocked products against keyword list
      try {
        const earlyKeywords = await state.getEarlyKeywords();
        if (earlyKeywords.length > 0) {
          for (const event of events) {
            if (!event.product?.name) continue;
            const nameLower = event.product.name.toLowerCase();
            const matched = earlyKeywords.find(kw => nameLower.includes(kw));
            if (matched) {
              event._earlyKeywordMatch = matched;
              logger.info(`EARLY KEYWORD MATCH: "${matched}" → ${event.product.name} (${adapter.name})`);
            }
          }
        }
      } catch (err) {
        logger.debug(`Early keyword check failed: ${err.message}`);
      }

      // Record restock timestamps and price changes
      for (const event of events) {
        if (event.type === EVENT_TYPES.RESTOCK && event.product?.sku) {
          await state.recordRestock(adapter.id, event.product.sku);
        }
        if (event.product?.sku && event.product?.price > 0) {
          await state.recordPrice(adapter.id, event.product.sku, event.product.price);
        }
      }

      eventCount = events.length;
      logger.info(`${adapter.name}: ${events.length} event(s) detected (poll: ${pollMs}ms)`);
      if (onEvents) {
        await onEvents(events);
      }
    }
  }

  // Save state via pipeline
  const entries = Object.entries(newProducts);
  if (entries.length > 0) {
    const pipeline = state.getRedis().pipeline();
    for (const [sku, product] of entries) {
      const key = `tcg:product:${hashSku(adapter.id, sku)}`;
      pipeline.set(key, JSON.stringify(product), 'EX', 86400 * 7);
    }
    await pipeline.exec();
    state.setRetailerIndex(adapter.id, newProducts);
  }

  // Clean up stale products (with partial-result safety)
  const oldCount = Object.keys(oldProducts).length;
  const newCount = Object.keys(newProducts).length;
  const isPartialResult = oldCount > 0 && newCount < oldCount * 0.3;

  if (isPartialResult) {
    logger.warn(`${adapter.name}: skipping stale cleanup — looks like a partial result (${newCount} new vs ${oldCount} cached)`);
  } else {
    const staleSkus = Object.keys(oldProducts).filter(sku => !(sku in newProducts));
    if (staleSkus.length > 0) {
      // Mark stale products as OOS instead of deleting — prevents mass false NEW_SKU on next poll (#C-1)
      const pipeline = state.getRedis().pipeline();
      for (const sku of staleSkus) {
        const product = oldProducts[sku];
        product.inStock = false;
        product.canAddToCart = false;
        product.lastSeen = Date.now();
        const key = `tcg:product:${hashSku(adapter.id, sku)}`;
        pipeline.set(key, JSON.stringify(product), 'EX', 86400 * 7);
      }
      await pipeline.exec();
      logger.info(`${adapter.name}: marked ${staleSkus.length} stale products as OOS`);
    }
  }

  await state.setLastCheck(adapter.id);
  await state.clearErrors(adapter.id);

  // Track product count for adapter health monitoring
  // Skip zero-product counter when cached products exist — this is a rate-limit, not a failure
  if (newCount === 0 && oldCount > 0) {
    // Rate-limited poll: don't penalize health — data is still in Redis from last successful poll
    logger.debug(`${adapter.name}: 0 products (rate-limited), skipping health counter (${oldCount} cached)`);
  } else {
    recordProductCount(adapter.id, newCount);
  }

  // Parse-quality canary — catches a parser that still returns rows but with empty fields
  recordParseQuality(adapter.id, newProducts, adapter.parseCanary !== false);

  // Detection health — adapters that can tell live data from cache report it here.
  // This is also the honest signal for the cadence controller: a poll that returns without
  // throwing is NOT the same as a poll that worked. Walmart in particular returns cleanly
  // with 0/4 searches through and zero products, and on exception-only signalling the
  // controller read that as a 100% success and sped up into a wall.
  let quality = null;
  if (adapter._lastFreshness) {
    const { fresh, attempted } = adapter._lastFreshness;
    recordFreshness(adapter.id, fresh, attempted);
    // attempted === 0 means nothing was due this cycle — neutral, not a failure.
    if (attempted > 0) quality = fresh > 0;
    adapter._lastFreshness = null;
  }
  // Fallback for adapters with no freshness signal: returning nothing when we previously
  // held products is a failed poll, however cleanly it returned.
  if (quality === null && newCount === 0 && oldCount > 0) quality = false;

  return { success: true, productCount: newCount, eventCount, pollMs, quality };
}

module.exports = { pollAdapterOnce };
