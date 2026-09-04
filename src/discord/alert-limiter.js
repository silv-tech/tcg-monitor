const logger = require('../monitoring/logger');

/**
 * Outbound alert circuit breaker.
 *
 * A bad diff can turn into hundreds of alerts in a minute — stale cached prices after a
 * cache-key change, a parser regression that flips a whole catalogue in or out of stock,
 * a retailer relisting its entire inventory. Whatever the cause, the customer-visible
 * symptom is the same: a flood, and a Discord nobody trusts afterwards.
 *
 * So volume is capped per retailer. Past the threshold that retailer is muted for a
 * cooldown, the rest keep flowing, and the admin gets told once. Suppressed alerts are
 * counted rather than queued: by the time a flood is over, the individual alerts are
 * stale anyway, and replaying them is a second flood.
 */

const WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_PER_WINDOW = 12;
const COOLDOWN_MS = 10 * 60 * 1000;

// A drop is exactly when a retailer legitimately fires several alerts at once, so the
// paths that carry drops get more headroom than routine catalogue churn.
const LIMITS = {
  walmart: 25,
  bestbuy: 20,
  costco: 20,
  amazon: 20,
  ebgames: 20,
  pokemoncenter: 15,
};

const windows = new Map();   // retailerId → { count, startedAt }
const muted = new Map();     // retailerId → { until, suppressed, reason }

let onTrip = null;
/** Register a callback fired once when a retailer is muted (used to ping the admin). */
function setTripHandler(fn) { onTrip = fn; }

function limitFor(retailerId) {
  return LIMITS[retailerId] || DEFAULT_MAX_PER_WINDOW;
}

/**
 * @returns {{ allowed: boolean, suppressed?: number }} — allowed=false means drop this alert
 */
function allow(event) {
  const retailerId = event.product?.retailerId || 'unknown';

  // Watchlist and admin-triggered events are the whole point of the product; a flood of
  // those means a real drop, and they are already capped by the size of the watchlist.
  if (event._scanTier || event.product?._watchlist) return { allowed: true };

  const now = Date.now();
  const mute = muted.get(retailerId);
  if (mute) {
    if (now < mute.until) {
      mute.suppressed++;
      return { allowed: false, suppressed: mute.suppressed };
    }
    logger.warn(`ALERT LIMITER: ${retailerId} unmuted after ${Math.round(COOLDOWN_MS / 60000)}min — ${mute.suppressed} alert(s) were suppressed`);
    muted.delete(retailerId);
    windows.delete(retailerId);
  }

  let w = windows.get(retailerId);
  if (!w || now - w.startedAt >= WINDOW_MS) {
    w = { count: 0, startedAt: now };
    windows.set(retailerId, w);
  }
  w.count++;

  const limit = limitFor(retailerId);
  if (w.count > limit) {
    const reason = `${w.count} alerts in ${Math.round((now - w.startedAt) / 1000)}s (limit ${limit}/min)`;
    muted.set(retailerId, { until: now + COOLDOWN_MS, suppressed: 1, reason });
    logger.error(`ALERT LIMITER: muting ${retailerId} for ${Math.round(COOLDOWN_MS / 60000)}min — ${reason}`);
    if (onTrip) {
      try { onTrip(retailerId, reason); } catch (err) { logger.warn(`Alert limiter trip handler failed: ${err.message}`); }
    }
    return { allowed: false, suppressed: 1 };
  }

  return { allowed: true };
}

/** Current mute state, for /status and the admin dashboard. */
function getStatus() {
  const now = Date.now();
  const out = {};
  for (const [id, m] of muted) {
    if (now >= m.until) continue;
    out[id] = { mutedForSec: Math.round((m.until - now) / 1000), suppressed: m.suppressed, reason: m.reason };
  }
  return out;
}

function reset(retailerId) {
  if (retailerId) { muted.delete(retailerId); windows.delete(retailerId); return; }
  muted.clear(); windows.clear();
}

module.exports = { allow, getStatus, reset, setTripHandler, LIMITS, DEFAULT_MAX_PER_WINDOW };
