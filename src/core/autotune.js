/**
 * Self-tuning poll cadence.
 *
 * Every store drifts. A retailer starts throttling us, a proxy pool degrades, a datacenter
 * route gets slow, an anti-bot vendor tightens a rule — and until now each of those needed a
 * human to notice a number had moved and hand-edit an interval. Two of today's regressions
 * (Walmart's stealth collapse, Best Buy's 10s poll) were exactly that shape.
 *
 * This closes the loop. It watches a rolling window of real poll outcomes per store and moves
 * that store's interval, using the same control law TCP uses for congestion: creep toward
 * faster when things are healthy, back off hard and immediately when they are not. Recovery is
 * therefore automatic — a store that gets blocked slows down, stops being blocked, and then
 * walks itself back to fast without anyone touching it.
 *
 * Two hard rules keep this from becoming the thing that breaks the system:
 *   1. It can never go below a store's floor. Those floors exist because of anti-bot limits,
 *      and a controller that could tune them away would eventually get us banned.
 *   2. It can never set an interval below what the store actually responds in. Polls that
 *      overlap their own interval get skipped, so the observed typical (median) poll latency
 *      acts as a moving floor underneath the configured one.
 */

const logger = require('../monitoring/logger');

const WINDOW = 20;              // polls remembered per store
const MIN_SAMPLES = 8;          // never act on a thin window
const EVAL_INTERVAL_MS = 60000; // how often the controller reconsiders

// Speed up gently, slow down sharply — being too fast gets us blocked, being slightly
// too slow only costs a little latency.
const SPEED_UP_STEP_MS = 500;
// Recovery is proportional, so climbing back is exponential. At 5% a store that hit its
// ceiling took ~45 minutes to return to full speed, which is far too long for a drop monitor;
// 15% brings that under 10 while still being visibly gentler than the backoff.
const SPEED_UP_FRACTION = 0.15;
const SLOW_DOWN_FACTOR = 1.5;

const HEALTHY_RATE = 0.9;       // above this, earn speed
const DEGRADED_RATE = 0.6;      // below this, give it room

// Per-store bounds. Floors are anti-bot limits discovered the hard way, not preferences.
// Ceilings are deliberately tight. A drop monitor that has quietly backed itself off to a
// minute between polls has stopped doing its job, so the cap is 30s: enough to relieve real
// pressure, not enough to silently become useless.
const BOUNDS = {
  walmart:       { floor: 6000, ceiling: 30000 },
  amazon:        { floor: 6000, ceiling: 30000 },
  costco:        { floor: 5000, ceiling: 30000 },
  bestbuy:       { floor: 5000, ceiling: 30000 },
  ebgames:       { floor: 5000, ceiling: 30000 },
  pokemoncenter: { floor: 8000, ceiling: 120000 },
};
const DEFAULT_BOUNDS = { floor: 8000, ceiling: 120000 };

const windows = new Map();  // retailerId -> [{ ok, ms, at }]
const lastChange = new Map();

function boundsFor(retailerId) {
  return BOUNDS[retailerId] || DEFAULT_BOUNDS;
}

/** Record one poll outcome. Called by the scheduler for every poll, success or failure. */
function recordPoll(retailerId, { ok, ms }) {
  if (!windows.has(retailerId)) windows.set(retailerId, []);
  const w = windows.get(retailerId);
  w.push({ ok: !!ok, ms: Number(ms) || 0, at: Date.now() });
  if (w.length > WINDOW) w.shift();
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

/**
 * Decide the next interval for one store.
 * @returns {{intervalMs: number, reason: string}|null} null when nothing should change.
 */
function decide(retailerId, currentIntervalMs) {
  const w = windows.get(retailerId);
  if (!w || w.length < MIN_SAMPLES) return null;

  const { floor, ceiling } = boundsFor(retailerId);
  const okCount = w.filter((s) => s.ok).length;
  const rate = okCount / w.length;

  // A poll that takes longer than its own interval overlaps the next one. Whatever the
  // success rate says, the interval can never sit below what this store actually costs.
  //
  // Deliberately the MEDIAN, not a tail percentile. On a 20-sample window a p95 is just the
  // maximum, so one cold-start poll — Amazon's first poll after a deploy runs ~10s against a
  // ~1s steady state — would have pinned the floor at 12s and permanently slowed a healthy
  // store. The median ignores that outlier; doubling it leaves the headroom the tail was for.
  const okLatencies = w.filter((s) => s.ok).map((s) => s.ms);
  const typical = percentile(okLatencies, 0.5);
  const latencyFloor = Math.ceil((typical * 2) / 500) * 500;
  const effectiveFloor = Math.max(floor, latencyFloor);

  let next = currentIntervalMs;
  let reason;

  if (rate < DEGRADED_RATE) {
    next = Math.min(ceiling, Math.round(currentIntervalMs * SLOW_DOWN_FACTOR));
    reason = `success ${(rate * 100).toFixed(0)}% below ${DEGRADED_RATE * 100}% — backing off`;
  } else if (rate >= HEALTHY_RATE && currentIntervalMs > effectiveFloor) {
    // Proportional, so a store that backed off a long way climbs back in minutes rather than
    // the ~40 a flat step would take, while a store already near its floor still inches.
    const step = Math.max(SPEED_UP_STEP_MS, Math.round((currentIntervalMs * SPEED_UP_FRACTION) / 500) * 500);
    next = Math.max(effectiveFloor, currentIntervalMs - step);
    reason = `success ${(rate * 100).toFixed(0)}% — speeding up toward ${effectiveFloor}ms`;
  } else if (currentIntervalMs < effectiveFloor) {
    // Latency grew under us; lift off the floor even though nothing is failing yet.
    next = effectiveFloor;
    reason = `typical poll ${typical}ms needs at least ${effectiveFloor}ms between polls`;
  } else {
    return null;
  }

  if (next === currentIntervalMs) return null;
  return { intervalMs: next, reason };
}

/**
 * Start the controller.
 * @param {object} scheduler - needs .adapters (Map) and .updateAdapter(id, changes)
 */
function start(scheduler) {
  const timer = setInterval(() => {
    for (const [id, adapter] of scheduler.adapters) {
      if (!adapter.enabled) continue;
      const verdict = decide(id, adapter.intervalMs);
      if (!verdict) continue;

      const from = adapter.intervalMs;
      scheduler.updateAdapter(id, { intervalMs: verdict.intervalMs });
      lastChange.set(id, { at: Date.now(), from, to: verdict.intervalMs, reason: verdict.reason });
      logger.info(`Autotune ${adapter.name}: ${from}ms -> ${verdict.intervalMs}ms (${verdict.reason})`);
    }
  }, EVAL_INTERVAL_MS);
  if (timer.unref) timer.unref();
  logger.info(`Autotune: watching ${scheduler.adapters.size} adapters, evaluating every ${EVAL_INTERVAL_MS / 1000}s`);
  return timer;
}

/** Inspection for the admin API. */
function getState() {
  const out = {};
  for (const [id, w] of windows) {
    const ok = w.filter((s) => s.ok).length;
    out[id] = {
      samples: w.length,
      successRate: w.length ? parseFloat((ok / w.length).toFixed(2)) : null,
      medianPollMs: percentile(w.filter((s) => s.ok).map((s) => s.ms), 0.5),
      bounds: boundsFor(id),
      lastChange: lastChange.get(id) || null,
    };
  }
  return out;
}

function _reset() {
  windows.clear();
  lastChange.clear();
}

module.exports = { recordPoll, decide, start, getState, _reset, WINDOW, MIN_SAMPLES };
