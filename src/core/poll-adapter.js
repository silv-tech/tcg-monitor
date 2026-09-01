const logger = require('../monitoring/logger');
const state = require('./state');
const { diffProducts, EVENT_TYPES } = require('./events');
const { recordPollLatency } = require('./proxy');
const { recordProductCount } = require('../monitoring/health');
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

  // Timeout wrapper
  const newProducts = await Promise.race([
    adapter.run(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Adapter timeout after ${adapterTimeout}ms`)), adapterTimeout)),
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
      const delPipeline = state.getRedis().pipeline();
      for (const sku of staleSkus) {
        delPipeline.del(`tcg:product:${hashSku(adapter.id, sku)}`);
      }
      await delPipeline.exec();
      logger.info(`${adapter.name}: cleaned up ${staleSkus.length} stale products from Redis`);
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

  return { success: true, productCount: newCount, eventCount, pollMs };
}

module.exports = { pollAdapterOnce };
