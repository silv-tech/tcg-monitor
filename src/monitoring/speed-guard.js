/**
 * Speed guard.
 *
 * The big six were tuned to detect a new listing in well under 10 seconds, and then drifted
 * back over it twice in one day without anyone noticing — first when autotune sped 31 shops up
 * and starved them, then again after a deploy. Both times it was caught by hand.
 *
 * This watches the same number the product is sold on (interval + typical poll time) and says
 * so, loudly, when a store crosses its target. It deliberately does NOT change anything:
 * autotune already showed that a controller free to move things can move them the wrong way.
 * This only reports, so a human decides.
 */

const logger = require('./logger');
const autotune = require('../core/autotune');

// What each store is expected to deliver, in milliseconds from a listing appearing to the
// alert being sent. These are the numbers the marketing site's "seconds" claim rests on.
const TARGETS = {
  walmart: 10000,
  costco: 10000,
  amazon: 10000,
  bestbuy: 10000,
  ebgames: 10000,
  pokemoncenter: 12000,
};

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// A store has to be over target on two consecutive checks before it is called out. One slow
// reading right after a deploy is a cold start, not a regression — chasing those is exactly
// how earlier measurements today produced wrong conclusions.
const STRIKES_BEFORE_WARNING = 2;
const MIN_SAMPLES = 5;

const strikes = new Map();

function check(scheduler) {
  const state = autotune.getState();
  const breaches = [];

  for (const [id, target] of Object.entries(TARGETS)) {
    const adapter = scheduler.adapters.get(id);
    const s = state[id];
    if (!adapter || !adapter.enabled || !s || s.samples < MIN_SAMPLES) {
      strikes.delete(id);
      continue;
    }

    const detectMs = adapter.intervalMs + (s.medianPollMs || 0);
    if (detectMs <= target) {
      if (strikes.get(id)) {
        logger.info(`SPEED GUARD: ${adapter.name} back under target (${(detectMs / 1000).toFixed(1)}s)`);
      }
      strikes.delete(id);
      continue;
    }

    const n = (strikes.get(id) || 0) + 1;
    strikes.set(id, n);
    if (n >= STRIKES_BEFORE_WARNING) {
      breaches.push(
        `${adapter.name} ${(detectMs / 1000).toFixed(1)}s (target ${(target / 1000).toFixed(0)}s, `
        + `interval ${adapter.intervalMs}ms + poll ${s.medianPollMs}ms)`,
      );
    }
  }

  if (breaches.length > 0) {
    logger.error(
      `SPEED GUARD: ${breaches.length} of the big six are over their detection target — `
      + breaches.join('; ')
      + '. Usual cause is poll time rising under load, not the interval.',
    );
  }
}

function start(scheduler) {
  const timer = setInterval(() => {
    try { check(scheduler); } catch (err) { logger.debug(`Speed guard failed: ${err.message}`); }
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  logger.info(`Speed guard: watching ${Object.keys(TARGETS).length} core retailers every ${CHECK_INTERVAL_MS / 60000}min`);
  return timer;
}

module.exports = { start, check, TARGETS };
