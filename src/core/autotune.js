/**
 * Self-tuning poll cadence.
 *
 * Every store drifts. A retailer starts throttling us, a proxy pool degrades, a datacenter
 * route gets slow, an anti-bot vendor tightens a rule — and each of those otherwise needs a
 * human to notice a number moved and hand-edit an interval. Two regressions on 2026-09-04
 * (Walmart's stealth collapse, Best Buy's 10s poll) were exactly that shape.
 *
 * This closes the loop: a rolling window of real poll outcomes per store drives that store's
 * interval, using the control law TCP uses for congestion — creep toward faster while healthy,
 * back off hard the moment the retailer pushes back. Recovery is automatic.
 *
 * Just as important is knowing when to STOP. An optimiser that keeps probing forever will
 * eventually push a healthy store into a wall, and "we were tuning it" is no comfort when a
 * drop was missed. So this remembers the best cadence it has actually observed, reverts to it
 * when a change makes things worse, and then deliberately settles — holding that known-good
 * setting instead of hunting. Speed is only worth having if the thing still works.
 *
 * Four hard rules:
 *   1. Never below a store's floor — those are anti-bot limits, and tuning them away gets us
 *      banned rather than fast.
 *   2. Never below what the store actually responds in. Overlapping polls get skipped, so the
 *      typical (median) poll latency is a moving floor beneath the configured one.
 *   3. A change that makes success worse is reverted, not kept.
 *   4. After repeated failed attempts to improve, stop trying and hold the best known setting.
 */

const logger = require('../monitoring/logger');

const WINDOW = 20;              // polls remembered per store
const MIN_SAMPLES = 8;          // never act on a thin window
const EVAL_INTERVAL_MS = 60000; // how often the controller reconsiders

// Speed up gently, slow down sharply — being too fast gets us blocked, being slightly
// too slow only costs a little latency.
const SPEED_UP_STEP_MS = 500;
const SPEED_UP_FRACTION = 0.15; // proportional, so recovery from a ceiling takes ~10min not ~45
const SLOW_DOWN_FACTOR = 1.5;

const HEALTHY_RATE = 0.9;       // above this, earn speed
const DEGRADED_RATE = 0.6;      // below this, give it room

// Knowing when to stop.
const REGRESSION_DROP = 0.15;   // success falling this far after a change means the change was bad
const MAX_FAILED_PROBES = 2;    // this many bad attempts and we stop hunting
const FREEZE_MS = 15 * 60 * 1000;      // pause after reverting one bad change
const SETTLE_MS = 60 * 60 * 1000;      // long hold once we accept the current setting is the best we have

// Per-store bounds. Floors are anti-bot limits discovered the hard way, not preferences.
// Ceilings are deliberately tight: a drop monitor that has quietly backed itself off to a
// minute between polls has stopped doing its job.
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
const memory = new Map();   // retailerId -> tuning memory (see newMemory)

function newMemory() {
  return {
    best: null,          // { intervalMs, rate } — best cadence actually observed
    pending: null,       // { from, to, rateBefore } — a change awaiting its verdict
    failedProbes: 0,     // consecutive changes that made things worse
    frozenUntil: 0,      // holding; not probing until this time
    settled: false,      // we believe we have the best setting available
    lastChange: null,    // for reporting
  };
}

function memFor(id) {
  if (!memory.has(id)) memory.set(id, newMemory());
  return memory.get(id);
}

function boundsFor(retailerId) {
  return BOUNDS[retailerId] || DEFAULT_BOUNDS;
}

/** Record one poll outcome. Called by the scheduler for every poll it can judge. */
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

function successRate(w) {
  return w.length ? w.filter((s) => s.ok).length / w.length : 0;
}

/**
 * Decide the next interval for one store.
 * @returns {{intervalMs: number, reason: string, revert?: boolean, settle?: boolean}|null}
 */
function decide(retailerId, currentIntervalMs, now = Date.now()) {
  const w = windows.get(retailerId);
  if (!w || w.length < MIN_SAMPLES) return null;

  const mem = memFor(retailerId);
  if (now < mem.frozenUntil) return null; // holding — deliberately not hunting

  const { floor, ceiling } = boundsFor(retailerId);
  const rate = successRate(w);

  // Rule 2: never poll faster than the store actually responds. Median, not a tail
  // percentile — on a 20-sample window p95 is just the maximum, so one cold-start poll
  // would pin a healthy store slow forever.
  const typical = percentile(w.filter((s) => s.ok).map((s) => s.ms), 0.5);
  // 1.5x, not 2x. Detection latency is interval + poll time, so an over-cautious multiplier
  // directly costs alert speed: Walmart's ~3.7s polls at 2x forced a 7500ms floor and an 11.2s
  // worst case, missing the sub-10s target on the one store that most needs it. The scheduler
  // SKIPS a poll that would overlap rather than queueing it, so the headroom here only has to
  // absorb normal variance, not guarantee zero overlap.
  const latencyFloor = Math.ceil((typical * 1.5) / 500) * 500;
  const effectiveFloor = Math.max(floor, latencyFloor);

  // Rule 3: judge the change we last made, now that we have fresh samples for it.
  if (mem.pending) {
    const { from, to, rateBefore } = mem.pending;
    mem.pending = null;
    if (rate < rateBefore - REGRESSION_DROP) {
      mem.failedProbes += 1;
      const settling = mem.failedProbes >= MAX_FAILED_PROBES;
      mem.frozenUntil = now + (settling ? SETTLE_MS : FREEZE_MS);
      mem.settled = settling;
      const holdFor = Math.round((settling ? SETTLE_MS : FREEZE_MS) / 60000);
      return {
        intervalMs: from,
        revert: true,
        settle: settling,
        reason: settling
          ? `${to}ms dropped success ${(rateBefore * 100).toFixed(0)}%->${(rate * 100).toFixed(0)}%; reverting and settling at ${from}ms for ${holdFor}min`
          : `${to}ms dropped success ${(rateBefore * 100).toFixed(0)}%->${(rate * 100).toFixed(0)}%; reverting to ${from}ms, holding ${holdFor}min`,
      };
    }
    // The change held up. Remember it if it is the best we have seen.
    mem.failedProbes = 0;
    if (!mem.best || rate > mem.best.rate || (rate >= mem.best.rate && to < mem.best.intervalMs)) {
      mem.best = { intervalMs: to, rate };
    }
  }

  let next = currentIntervalMs;
  let reason;

  if (rate < DEGRADED_RATE) {
    // Backing off is always allowed, even when settled — safety outranks stability.
    next = Math.min(ceiling, Math.round(currentIntervalMs * SLOW_DOWN_FACTOR));
    reason = `success ${(rate * 100).toFixed(0)}% below ${DEGRADED_RATE * 100}% — backing off`;
    mem.settled = false;
  } else if (currentIntervalMs < effectiveFloor) {
    next = effectiveFloor;
    reason = `typical poll ${typical}ms needs at least ${effectiveFloor}ms between polls`;
  } else if (mem.settled) {
    return null; // Rule 4: we have the best setting we know of. Stop pushing.
  } else if (rate >= HEALTHY_RATE && currentIntervalMs > effectiveFloor) {
    const step = Math.max(SPEED_UP_STEP_MS, Math.round((currentIntervalMs * SPEED_UP_FRACTION) / 500) * 500);
    next = Math.max(effectiveFloor, currentIntervalMs - step);
    reason = `success ${(rate * 100).toFixed(0)}% — speeding up toward ${effectiveFloor}ms`;
  } else {
    return null;
  }

  if (next === currentIntervalMs) return null;
  return { intervalMs: next, reason };
}

/** Called after a verdict is applied, so the next evaluation can judge it. */
function noteApplied(retailerId, from, to, opts = {}) {
  const mem = memFor(retailerId);
  const w = windows.get(retailerId) || [];
  mem.lastChange = { at: Date.now(), from, to, reason: opts.reason || '' };
  // A reverted change is its own verdict — don't re-judge it.
  mem.pending = opts.revert ? null : { from, to, rateBefore: successRate(w) };
  // Samples from the old cadence do not describe the new one.
  windows.set(retailerId, []);
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
      noteApplied(id, from, verdict.intervalMs, verdict);
      const tag = verdict.settle ? 'SETTLED' : verdict.revert ? 'REVERT' : 'tune';
      logger.info(`Autotune ${adapter.name} [${tag}]: ${from}ms -> ${verdict.intervalMs}ms (${verdict.reason})`);
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
    const mem = memFor(id);
    out[id] = {
      samples: w.length,
      successRate: w.length ? parseFloat(successRate(w).toFixed(2)) : null,
      medianPollMs: percentile(w.filter((s) => s.ok).map((s) => s.ms), 0.5),
      bounds: boundsFor(id),
      best: mem.best,
      settled: mem.settled,
      failedProbes: mem.failedProbes,
      holdingForMs: Math.max(0, mem.frozenUntil - Date.now()),
      lastChange: mem.lastChange,
    };
  }
  return out;
}

function _reset() {
  windows.clear();
  memory.clear();
}

module.exports = {
  recordPoll, decide, noteApplied, start, getState, _reset,
  WINDOW, MIN_SAMPLES, MAX_FAILED_PROBES,
};
