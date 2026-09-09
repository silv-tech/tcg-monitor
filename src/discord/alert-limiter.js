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

/**
 * How many HIGH-VALUE alerts may still escape a single mute.
 *
 * A mute drops everything for that retailer, and a dropped RESTOCK is lost PERMANENTLY: poll
 * -adapter writes the new product state immediately after delivery, so oldProduct.inStock is
 * already true on the next poll and events.js can never re-fire it. On 2026-09-09 Amazon was
 * muted for ten minutes and 40 alerts went in the bin — the flood itself was harmless
 * first-sightings, but any genuine restock in that window went with them, unrecoverably.
 *
 * Deliberately NOT an unconditional exemption. The identity exemption below returns before the
 * counter increments, so exempting RESTOCK outright would make the limiter blind to a mass-
 * RESTOCK regression — which is the exact failure it was built for (EB Games once produced 289
 * restock alerts in three days from stale state). A small budget per mute keeps the ceiling
 * intact: a 40-alert flood costs three extra messages, and so would a 289-alert one.
 *
 * Not a replay queue either: released ten minutes later, a price and stock flag are stale, and
 * delivery's out-of-stock guard deliberately exempts RESTOCK so it would not catch it. A wrong
 * value is worse than a missing one. These go out live or not at all.
 */
const MUTE_ESCAPE_BUDGET = Number(process.env.ALERT_MUTE_ESCAPE) || 3;
// A restock IS the product. Everything else can wait for the next poll.
const HIGH_VALUE_TYPES = new Set(['RESTOCK', 'PREORDER_LIVE']);

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

/**
 * The ceiling scales with catalogue size, because a flat count means opposite things at
 * opposite ends of the shop list.
 *
 * Measured against the live catalogues: 12/min is 0.05% of pokejeux (24,471 products, 17,824
 * of them in stock) but 46% of London Drugs (26 products). So the flat number was strangling
 * exactly the large Shopify shops where a genuine sale most often fires many alerts at once —
 * it muted a real sale at remicardtrader (4,497 products, 1,970 in stock) — while being loose
 * on the small catalogues where a regression would be most obvious.
 *
 * Share of catalogue is the signal that actually separates the two cases: a real sale touches
 * a small slice, a parser or cache regression flips a large one.
 *
 * This can only ever RAISE a retailer's ceiling. limitFor() takes the max of the explicit
 * override and the scaled value, so no store becomes easier to mute than it is today.
 */
const CATALOGUE_SHARE = 0.02;
const MIN_LIMIT = 15;
// A true runaway is still contained: past this it is systemic whatever the catalogue size.
const MAX_LIMIT = 120;

const catalogueSizes = new Map();  // retailerId → last known product count

/** Called after each poll with that retailer's catalogue size. */
function setCatalogueSize(retailerId, count) {
  if (Number.isFinite(count) && count > 0) catalogueSizes.set(retailerId, count);
}

// Names of suppressed products, so a mute is never fully invisible. Capped: the point is to
// show the admin WHAT was dropped, not to replay a flood.
const SUPPRESS_SAMPLE = 25;

const windows = new Map();   // retailerId → { count, startedAt }
const muted = new Map();     // retailerId → { until, suppressed, reason }

let onTrip = null;
let onRecover = null;
/** Register a callback fired once when a retailer is muted (used to ping the admin). */
function setTripHandler(fn) { onTrip = fn; }
/** Register a callback fired once when a retailer unmutes, with what was dropped. */
function setRecoverHandler(fn) { onRecover = fn; }

function limitFor(retailerId) {
  const explicit = LIMITS[retailerId] || DEFAULT_MAX_PER_WINDOW;
  const size = catalogueSizes.get(retailerId) || 0;
  const scaled = size > 0 ? Math.ceil(size * CATALOGUE_SHARE) : 0;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, explicit, scaled));
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
      // Refill the escape budget once per window rather than once per mute.
      //
      // It was per-mute, which meant three restocks per TEN MINUTES. On 2026-09-09 a restart
      // flood spent all three in the same millisecond it tripped the mute, leaving Amazon with
      // no protection at all for the remaining ten minutes — and a suppressed restock is gone
      // for good, because poll-adapter writes the new state immediately after delivery.
      //
      // Per-window keeps the limiter's purpose intact: a genuine mass-RESTOCK regression still
      // costs at most MUTE_ESCAPE_BUDGET messages a minute and still trips and holds the mute,
      // so it stays visible rather than being exempted into invisibility.
      if (now - mute.escapeWindowAt >= WINDOW_MS) {
        mute.escapeWindowAt = now;
        mute.escapes = MUTE_ESCAPE_BUDGET;
      }

      // Let a bounded number of genuine restocks through. This is the only alert that cannot
      // be recovered later, so it is the only one worth spending the budget on.
      if (mute.escapes > 0 && HIGH_VALUE_TYPES.has(event.type) && event.product?.inStock) {
        mute.escapes -= 1;
        logger.warn(`ALERT LIMITER: ${retailerId} is muted, but letting a ${event.type} through `
          + `(${mute.escapes} escape(s) left): ${event.product?.name || 'unknown'}`);
        return { allowed: true, escaped: true };
      }
      mute.suppressed++;
      const name = event.product?.name;
      if (name && mute.products.length < SUPPRESS_SAMPLE) mute.products.push(name);
      return { allowed: false, suppressed: mute.suppressed };
    }
    logger.warn(`ALERT LIMITER: ${retailerId} unmuted after ${Math.round(COOLDOWN_MS / 60000)}min — ${mute.suppressed} alert(s) were suppressed`);
    // Report what was dropped. Suppressed alerts are deliberately not replayed — by now they
    // are stale and replaying them is a second flood — but they must not vanish without
    // anyone being able to see which products were affected.
    if (onRecover) {
      try {
        onRecover(retailerId, { suppressed: mute.suppressed, products: mute.products.slice(), reason: mute.reason });
      } catch (err) { logger.warn(`Alert limiter recover handler failed: ${err.message}`); }
    }
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
    muted.set(retailerId, {
      until: now + COOLDOWN_MS,
      suppressed: 1,
      reason,
      products: [event.product?.name].filter(Boolean),
      escapes: MUTE_ESCAPE_BUDGET,
      escapeWindowAt: now,          // refilled every WINDOW_MS while the mute holds
    });
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

module.exports = {
  allow, getStatus, reset, setTripHandler, setRecoverHandler, setCatalogueSize, limitFor,
  LIMITS, DEFAULT_MAX_PER_WINDOW, MIN_LIMIT, MAX_LIMIT, CATALOGUE_SHARE,
  // Exported so delivery.js can log an unrecoverable loss differently from ordinary noise.
  HIGH_VALUE_TYPES, MUTE_ESCAPE_BUDGET,
};
