const logger = require('../monitoring/logger');
const state = require('./state');
const { diffProducts, EVENT_TYPES } = require('./events');
const { recordPollLatency } = require('./proxy');

const { recordProductCount } = require('../monitoring/health');
const { pollAdapterOnce } = require('./poll-adapter');
const { recordRestock, recordPrice } = require('./state');

// Circuit breaker thresholds
// Hard floor for watchlist fast-polling. Walmart's JSON legs are ~7KB so the limit is
// PerimeterX block rate, not bandwidth; below ~1.5s the challenge rate climbs sharply.
const WATCHLIST_FLOOR_MS = 1500;
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
    // Redis watchdog pause (#3)
    if (this._redisPaused) {
      logger.debug(`${adapter.name}: skipping poll — Redis is down`);
      return false;
    }

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
    const circuit = this._getCircuit(adapter.id);
    const defaultTimeout = Math.max(adapter.intervalMs * 2, 120000);
    const ADAPTER_TIMEOUT = typeof adapter.timingValue === 'function'
      ? adapter.timingValue('pollTimeoutMs', defaultTimeout, 30000)
      : defaultTimeout;

    try {
      // Delegate to extracted poll module (#22)
      await pollAdapterOnce(adapter, circuit, this.onEvents, ADAPTER_TIMEOUT);

      // Success — reset circuit breaker
      if (circuit.state === 'open') {
        this._closeCircuit(adapter);
      }
      circuit.errors = 0;
    } catch (err) {
      recordPollLatency(adapter.id, 0);
      await state.recordError(adapter.id, err);

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

  // Fast-poll watchlist items — separate from full adapter polls
  // Detects both NEW products and stock changes (OOS→in-stock) on watched SKUs
  async pollWatchlist(adapter) {
    const watchlistKey = `${adapter.id}:watchlist`;
    if (this.polling.has(watchlistKey)) return;
    if (!adapter.watchlist || adapter.watchlist.size === 0) return;

    this.polling.add(watchlistKey);
    try {
      for (const productId of adapter.watchlist) {
        const product = await adapter.fetchProductPage(productId);
        if (!product) continue; // 404, blocked, or parse failure

        const key = product.sku;
        const oldProduct = await state.getProduct(adapter.id, key);

        if (oldProduct) {
          // Already known — check for stock changes (RESTOCK, PRICE_CHANGE)
          const events = diffProducts({ [key]: oldProduct }, { [key]: product });
          if (events.length > 0) {
            const detectedAt = Date.now();
            for (const event of events) {
              event._detectedAt = detectedAt;
            }
            // Record restock/price history for watchlist events
            for (const event of events) {
              if (event.type === EVENT_TYPES.RESTOCK && event.product?.sku) {
                await recordRestock(adapter.id, event.product.sku);
              }
              if (event.product?.sku && event.product?.price > 0) {
                await recordPrice(adapter.id, event.product.sku, event.product.price);
              }
            }
            logger.info(`WATCHLIST: ${adapter.name} — ${events.length} event(s) for ${productId}: ${events.map(e => e.type).join(', ')}`);
            if (this.onEvents) {
              await this.onEvents(events);
            }
          }
          // Always update state with latest data
          await state.setProduct(adapter.id, key, product);
        } else {
          // NEW product from watchlist — fire NEW_SKU event
          const events = diffProducts({}, { [key]: product });
          if (events.length > 0) {
            const detectedAt = Date.now();
            for (const event of events) {
              event._detectedAt = detectedAt;
            }
            // Record price for new watchlist products
            for (const event of events) {
              if (event.product?.sku && event.product?.price > 0) {
                await recordPrice(adapter.id, event.product.sku, event.product.price);
              }
            }
            logger.info(`WATCHLIST: ${adapter.name} — NEW product ${productId}: ${events.map(e => e.type).join(', ')}`);
            if (this.onEvents) {
              await this.onEvents(events);
            }
          }
          await state.setProduct(adapter.id, key, product);
        }
      }
    } catch (err) {
      logger.warn(`${adapter.name}: watchlist fast-poll error: ${err.message}`);
    } finally {
      this.polling.delete(watchlistKey);
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // P2-4: Clear any leftover timers to prevent double-polling on re-start
    for (const [, timer] of this.timers) {
      this._clearTimer(timer);
    }
    this.timers.clear();

    // Merge watchlist overrides from Redis (SKUs added via /watchlist-add survive deploys)
    try {
      const wlOverrides = await state.getWatchlistOverrides();
      for (const [retailerId, skus] of Object.entries(wlOverrides)) {
        const adapter = this.adapters.get(retailerId);
        if (!adapter || !Array.isArray(skus)) continue;
        if (!adapter.watchlist) adapter.watchlist = new Set();
        let added = 0;
        for (const sku of skus) {
          if (!adapter.watchlist.has(sku)) {
            adapter.watchlist.add(sku);
            added++;
          }
        }
        if (added > 0) logger.info(`Restored ${added} watchlist SKUs from Redis for ${adapter.name}`);
      }
    } catch (err) {
      logger.warn(`Failed to restore watchlist overrides from Redis: ${err.message}`);
    }

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

      if (adapter.watchlist && adapter.watchlist.size > 0) {
        this._startWatchlistLoop(adapter);
      }

      stagger += 3000;
    }

    // Redis health watchdog (#3) — check every 30s, pause polls if Redis is down
    this._redisWatchdog = setInterval(async () => {
      try {
        await state.getRedis().ping();
        if (this._redisPaused) {
          this._redisPaused = false;
          logger.info('REDIS WATCHDOG: Redis recovered — resuming polls');
        }
      } catch (err) {
        if (!this._redisPaused) {
          this._redisPaused = true;
          logger.error(`REDIS WATCHDOG: Redis unreachable (${err.message}) — pausing polls until recovery`);
        }
      }
    }, 30000);
  }

  stop() {
    this.running = false;
    for (const [, timer] of this.timers) {
      this._clearTimer(timer);
    }
    this.timers.clear();
    if (this._redisWatchdog) {
      clearInterval(this._redisWatchdog);
      this._redisWatchdog = null;
    }
    logger.info('Scheduler stopped');
  }

  /**
   * Live-update an adapter's interval or enabled state without restarting.
   * Called from admin PATCH /api/retailers/:id.
   */
  updateAdapter(adapterId, changes) {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;

    // Apply changes to the live adapter instance
    if (changes.intervalMs !== undefined) adapter.intervalMs = changes.intervalMs;
    if (changes.enabled !== undefined) adapter.enabled = changes.enabled;
    if (changes.timing !== undefined && typeof adapter.applyTiming === 'function') {
      adapter.applyTiming(changes.timing);
      logger.info(`${adapter.name}: timing updated — ${JSON.stringify(changes.timing)}`);
    }

    // Clear existing timers (main poll + watchlist)
    const existingTimer = this.timers.get(adapterId);
    if (existingTimer) {
      this._clearTimer(existingTimer);
      this.timers.delete(adapterId);
    }
    const wlTimer = this.timers.get(`${adapterId}:watchlist`);
    if (wlTimer) {
      this._clearTimer(wlTimer);
      this.timers.delete(`${adapterId}:watchlist`);
    }

    if (!this.running) return;

    if (adapter.enabled) {
      // Create new timer with updated interval
      const timer = setInterval(() => {
        if (this.running) this.pollAdapter(adapter);
      }, adapter.intervalMs);
      this.timers.set(adapterId, timer);

      // Restart watchlist timer if adapter has a watchlist
      if (adapter.watchlist && adapter.watchlist.size > 0) {
        this.ensureWatchlistTimer(adapterId);
      }
      logger.info(`${adapter.name}: live-updated — polling every ${adapter.intervalMs}ms`);
    } else {
      logger.info(`${adapter.name}: live-disabled — polling stopped`);
    }
  }

  /**
   * Get a registered adapter by ID (for admin API watchlist management).
   */
  getAdapter(adapterId) {
    return this.adapters.get(adapterId) || null;
  }

  /**
   * Ensure a watchlist fast-poll timer exists for the given adapter.
   * Called when a SKU is added to a watchlist at runtime.
   */
  ensureWatchlistTimer(adapterId) {
    if (!this.running) return;
    const adapter = this.adapters.get(adapterId);
    if (!adapter || !adapter.watchlist || adapter.watchlist.size === 0) return;
    this._startWatchlistLoop(adapter);
  }

  // Self-scheduling loop: the next check starts the moment the previous one finishes (subject to
  // the floor). A fixed setInterval plus the overlap guard alternated 2s/4s between checks.
  _startWatchlistLoop(adapter) {
    const key = `${adapter.id}:watchlist`;
    if (this.timers.has(key)) return;
    const defaultFloor = adapter.id === 'walmart' ? 2000 : 5000;
    const floorMs = typeof adapter.timingValue === 'function'
      ? adapter.timingValue('watchlistIntervalMs', defaultFloor, WATCHLIST_FLOOR_MS)
      : defaultFloor;
    const loop = { stopped: false, stop() { loop.stopped = true; } };
    this.timers.set(key, loop);
    (async () => {
      while (this.running && !loop.stopped) {
        const started = Date.now();
        await this.pollWatchlist(adapter);
        const wait = floorMs - (Date.now() - started);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      }
    })();
    logger.info(`Fast watchlist polling started for ${adapter.name}: ${adapter.watchlist.size} SKUs, floor ${floorMs / 1000}s`);
  }

  _clearTimer(timer) {
    if (timer && typeof timer.stop === 'function') timer.stop();
    else clearInterval(timer);
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
