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

  // Product keys carry a 7-day TTL and each poll only refreshes what the retailer actually
  // surfaced — Walmart's search returns 5-8 of ~353 known products — so most entries age out
  // untouched. When one later reappears in results the diff has no record of it and fires a
  // NEW_SKU, alerting a "new product" that has been on the shelf for weeks. This set remembers
  // every SKU we have ever seen, well past the product TTL, purely to catch that case.
  const SEEN_KEY = `tcg:seen:${adapter.id}`;
  const SEEN_TTL_SEC = 86400 * 30;

  let eventCount = 0;
  if (!isFirstPoll) {
    let events = diffProducts(oldProducts, newProducts);

    // Drop NEW_SKU events for products we have seen before — they are reappearances.
    const newSkuEvents = events.filter(
      (e) => e.type === EVENT_TYPES.NEW_SKU && e.product && e.product.sku != null,
    );
    if (newSkuEvents.length > 0) {
      try {
        const checkPipe = state.getRedis().pipeline();
        for (const e of newSkuEvents) checkPipe.sismember(SEEN_KEY, String(e.product.sku));
        const checked = await checkPipe.exec();
        const stale = new Set();
        newSkuEvents.forEach((e, i) => {
          if (checked && checked[i] && checked[i][1]) stale.add(e);
        });
        if (stale.size > 0) {
          events = events.filter((e) => !stale.has(e));
          logger.info(`${adapter.name}: suppressed ${stale.size} false NEW_SKU (SKU seen before — cache had aged out)`);
        }
      } catch (err) {
        // Never let the de-dup lookup block real alerting.
        logger.debug(`${adapter.name}: NEW_SKU seen-check failed: ${err.message}`);
      }
    }

    if (events.length > 0) {
      // Stamp the moment the poll STARTED, not the moment the diff finished. The diff runs
      // after the fetch has already returned, so stamping here measured only diff -> embed
      // (~0.1s) and advertised that as detection speed, while the fetch that actually found
      // the change (~1.8s avg) was excluded entirely. The badge read 0.1s for something that
      // really took seconds.
      for (const event of events) {
        event._detectedAt = pollStart;
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

    // Remember every SKU we know of — this poll's results AND everything already cached — so
    // a later reappearance is never mistaken for new. Seeding from oldProducts matters on an
    // existing deployment: without it the set would only learn the handful of products each
    // poll surfaces, and the rest would still misfire when their 7-day TTL lapsed.
    try {
      const skus = [...new Set([...Object.keys(newProducts), ...Object.keys(oldProducts)])].map(String);
      const seenPipe = state.getRedis().pipeline();
      for (let i = 0; i < skus.length; i += 500) seenPipe.sadd(SEEN_KEY, ...skus.slice(i, i + 500));
      seenPipe.expire(SEEN_KEY, SEEN_TTL_SEC);
      await seenPipe.exec();
    } catch (err) {
      logger.debug(`${adapter.name}: seen-set update failed: ${err.message}`);
    }
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
  // Fallback when there is no usable freshness signal — either the adapter emits none
  // (EB Games) or nothing was due this cycle (Pokemon Center reports attempted: 0 when no
  // paid check is owed). Judge on whether the poll produced products at all, but only once
  // there is a baseline to compare against, so a cold start is not read as breakage.
  //
  // This has to be symmetric. Scoring only the failures meant EB Games could accumulate
  // nothing but failures and never earn a speed-up, and Pokemon Center was never sampled at
  // all — both were invisible to the controller.
  if (quality === null && oldCount > 0) quality = newCount > 0;

  return { success: true, productCount: newCount, eventCount, pollMs, quality };
}

module.exports = { pollAdapterOnce };
