const logger = require('../monitoring/logger');
const state = require('./state');
const { diffProducts, EVENT_TYPES } = require('./events');
const { recordPollLatency } = require('./proxy');
const { sleep } = require('../utils/helpers');

// Circuit breaker thresholds
const CIRCUIT_ERROR_THRESHOLD = 5;   // consecutive errors to trip
const CIRCUIT_PROBE_INTERVAL = 300000; // 5 minutes between recovery probes

class Scheduler {
  constructor() {
    this.adapters = new Map();
    this.timers = new Map();
    this.polling = new Set(); // track in-progress polls to prevent overlap
    this.running = false;
    this.onEvents = null; // callback: (events) => {}

    // Circuit breaker state per adapter
    this.circuits = new Map(); // adapterId → { state: 'closed'|'open', errors: 0, openedAt, lastProbe }
  }

  register(adapter) {
    this.adapters.set(adapter.id, adapter);
    this.circuits.set(adapter.id, { state: 'closed', errors: 0, openedAt: null, lastProbe: null });
    logger.info(`Registered adapter: ${adapter.name} (every ${adapter.intervalMs}ms)`);
  }

  setEventHandler(handler) {
    this.onEvents = handler;
  }

  _getCircuit(adapterId) {
    if (!this.circuits.has(adapterId)) {
      this.circuits.set(adapterId, { state: 'closed', errors: 0, openedAt: null, lastProbe: null });
    }
    return this.circuits.get(adapterId);
  }

  _tripCircuit(adapter) {
    const circuit = this._getCircuit(adapter.id);
    if (circuit.state === 'open') return; // already open

    circuit.state = 'open';
    circuit.openedAt = Date.now();
    logger.warn(`CIRCUIT BREAKER: ${adapter.name} auto-disabled after ${circuit.errors} consecutive errors. Recovery probes every ${CIRCUIT_PROBE_INTERVAL / 60000} min.`);
  }

  _closeCircuit(adapter) {
    const circuit = this._getCircuit(adapter.id);
    if (circuit.state === 'closed') return;

    const downtime = Math.round((Date.now() - circuit.openedAt) / 60000);
    circuit.state = 'closed';
    circuit.errors = 0;
    circuit.openedAt = null;
    circuit.lastProbe = null;
    logger.info(`CIRCUIT BREAKER: ${adapter.name} auto-recovered after ${downtime} min downtime. Resuming normal polling.`);
  }

  _shouldPoll(adapter) {
    const circuit = this._getCircuit(adapter.id);

    if (circuit.state === 'closed') return true;

    // Circuit is open — only allow periodic recovery probes
    const now = Date.now();
    if (!circuit.lastProbe || (now - circuit.lastProbe) >= CIRCUIT_PROBE_INTERVAL) {
      circuit.lastProbe = now;
      logger.info(`CIRCUIT BREAKER: ${adapter.name} — sending recovery probe...`);
      return true; // allow this one poll as a probe
    }

    return false; // skip — too soon since last probe
  }

  async pollAdapter(adapter) {
    if (this.polling.has(adapter.id)) {
      logger.debug(`${adapter.name}: skipping poll — previous poll still in progress`);
      return;
    }

    // Circuit breaker check
    if (!this._shouldPoll(adapter)) return;

    this.polling.add(adapter.id);
    const pollStart = Date.now();
    const circuit = this._getCircuit(adapter.id);

    try {
      const newProducts = await adapter.run();
      const pollMs = Date.now() - pollStart;
      recordPollLatency(adapter.id, pollMs);

      const oldProducts = await state.getAllProducts(adapter.id);

      // Seed mode: first poll for a retailer — cache products without firing events (P1-1)
      const isFirstPoll = Object.keys(oldProducts).length === 0 && Object.keys(newProducts).length > 0;
      if (isFirstPoll) {
        logger.info(`${adapter.name}: first poll — seeding ${Object.keys(newProducts).length} products (no alerts fired)`);
      }

      if (!isFirstPoll) {
        const events = diffProducts(oldProducts, newProducts);

        if (events.length > 0) {
          // Stamp detection time on events for delivery latency tracking
          const detectedAt = Date.now();
          for (const event of events) {
            event._detectedAt = detectedAt;
          }
          // Record restock timestamps for history tracking
          for (const event of events) {
            if (event.type === EVENT_TYPES.RESTOCK && event.product?.sku) {
              await state.recordRestock(adapter.id, event.product.sku);
            }
          }

          logger.info(`${adapter.name}: ${events.length} event(s) detected (poll: ${pollMs}ms)`);
          if (this.onEvents) {
            await this.onEvents(events);
          }
        }
      }

      // Save state AFTER successful delivery — if delivery fails, events re-fire next poll
      for (const [sku, product] of Object.entries(newProducts)) {
        await state.setProduct(adapter.id, sku, product);
      }

      // Clean up stale products no longer returned by the adapter
      // SAFETY: Skip cleanup if the new result looks partial — prevents mass false alerts
      // when an adapter returns fewer products due to a flaky search URL or rate limit.
      const oldCount = Object.keys(oldProducts).length;
      const newCount = Object.keys(newProducts).length;
      const isPartialResult = oldCount > 0 && newCount < oldCount * 0.5;

      if (isPartialResult) {
        logger.warn(`${adapter.name}: skipping stale cleanup — looks like a partial result (${newCount} new vs ${oldCount} cached). This prevents mass false alerts.`);
      } else {
        const staleSkus = Object.keys(oldProducts).filter(sku => !(sku in newProducts));
        if (staleSkus.length > 0) {
          for (const sku of staleSkus) {
            await state.deleteProduct(adapter.id, sku);
          }
          logger.info(`${adapter.name}: cleaned up ${staleSkus.length} stale products from Redis`);
        }
      }

      await state.setLastCheck(adapter.id);
      await state.clearErrors(adapter.id);

      // Success — reset circuit breaker
      if (circuit.state === 'open') {
        this._closeCircuit(adapter);
      }
      circuit.errors = 0;
    } catch (err) {
      const pollMs = Date.now() - pollStart;
      recordPollLatency(adapter.id, pollMs);
      const status = await state.recordError(adapter.id, err);

      // Increment circuit error count
      circuit.errors++;

      if (circuit.errors >= CIRCUIT_ERROR_THRESHOLD && circuit.state === 'closed') {
        this._tripCircuit(adapter);
      }

      logger.error(`${adapter.name}: poll error (${circuit.errors} consecutive)`, {
        error: err.message,
      });
    } finally {
      this.polling.delete(adapter.id);
    }
  }

  // Fast-poll only watchlist items (every ~5s) — separate from full adapter polls
  async pollWatchlist(adapter) {
    const watchlistKey = `${adapter.id}:watchlist`;
    if (this.polling.has(watchlistKey)) return;
    if (!adapter.watchlist || adapter.watchlist.size === 0) return;

    // Don't fast-poll watchlist if circuit is open
    const circuit = this._getCircuit(adapter.id);
    if (circuit.state === 'open') return;

    this.polling.add(watchlistKey);
    try {
      for (const productId of adapter.watchlist) {
        const product = await adapter.fetchProductPage(productId);
        if (!product) continue; // still 404 — not live yet

        // Product went live! Check against state
        const oldProducts = await state.getAllProducts(adapter.id);
        const key = product.sku;
        if (oldProducts[key]) continue; // already known, skip

        // NEW product from watchlist — fire event
        const { diffProducts } = require('./events');
        const events = diffProducts({}, { [key]: product });
        if (events.length > 0) {
          const detectedAt = Date.now();
          for (const event of events) {
            event._detectedAt = detectedAt;
          }
          logger.info(`WATCHLIST: ${adapter.name} — ${events.length} event(s) for ${productId}`);
          if (this.onEvents) {
            await this.onEvents(events);
          }
          // Save state so we don't re-fire
          await state.setProduct(adapter.id, key, product);
        }
      }
    } catch (err) {
      logger.debug(`${adapter.name}: watchlist fast-poll error: ${err.message}`);
    } finally {
      this.polling.delete(watchlistKey);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // P2-4: Clear any leftover timers to prevent double-polling on re-start
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();

    logger.info(`Scheduler starting with ${this.adapters.size} adapters`);

    let stagger = 0;
    for (const [id, adapter] of this.adapters) {
      if (!adapter.enabled) {
        logger.info(`Skipping disabled adapter: ${adapter.name}`);
        continue;
      }

      // Stagger initial polls so they don't all fire at once
      setTimeout(() => {
        this.pollAdapter(adapter);
        const timer = setInterval(() => {
          if (this.running) this.pollAdapter(adapter);
        }, adapter.intervalMs);
        this.timers.set(id, timer);
      }, stagger);

      // Fast watchlist polling (every 5s) for adapters that have one
      if (adapter.watchlist && adapter.watchlist.size > 0) {
        const wlTimer = setInterval(() => {
          if (this.running) this.pollWatchlist(adapter);
        }, 5000);
        this.timers.set(`${id}:watchlist`, wlTimer);
        logger.info(`Fast watchlist polling enabled for ${adapter.name}: ${adapter.watchlist.size} PIDs every 5s`);
      }

      stagger += 3000;
    }
  }

  stop() {
    this.running = false;
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    logger.info('Scheduler stopped');
  }

  // Expose circuit breaker status for the admin API
  getCircuitStatus() {
    const status = {};
    for (const [id, circuit] of this.circuits) {
      status[id] = {
        state: circuit.state,
        errors: circuit.errors,
        openedAt: circuit.openedAt,
        downtimeMin: circuit.openedAt ? Math.round((Date.now() - circuit.openedAt) / 60000) : 0,
      };
    }
    return status;
  }
}

module.exports = new Scheduler();
