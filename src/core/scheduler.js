const logger = require('../monitoring/logger');
const state = require('./state');
const { diffProducts } = require('./events');
const { sleep } = require('../utils/helpers');

class Scheduler {
  constructor() {
    this.adapters = new Map();
    this.timers = new Map();
    this.running = false;
    this.onEvents = null; // callback: (events) => {}
  }

  register(adapter) {
    this.adapters.set(adapter.id, adapter);
    logger.info(`Registered adapter: ${adapter.name} (every ${adapter.intervalMs}ms)`);
  }

  setEventHandler(handler) {
    this.onEvents = handler;
  }

  async pollAdapter(adapter) {
    try {
      const newProducts = await adapter.run();
      const oldProducts = await state.getAllProducts(adapter.id);

      const events = diffProducts(oldProducts, newProducts);

      // Save new state
      for (const [sku, product] of Object.entries(newProducts)) {
        await state.setProduct(adapter.id, sku, product);
      }
      await state.setLastCheck(adapter.id);
      await state.clearErrors(adapter.id);

      if (events.length > 0) {
        logger.info(`${adapter.name}: ${events.length} event(s) detected`);
        if (this.onEvents) {
          await this.onEvents(events);
        }
      }
    } catch (err) {
      const status = await state.recordError(adapter.id, err);
      logger.error(`${adapter.name}: poll error (${status.errors} consecutive)`, {
        error: err.message,
      });
    }
  }

  async start() {
    if (this.running) return;
    this.running = true;
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
}

module.exports = new Scheduler();
