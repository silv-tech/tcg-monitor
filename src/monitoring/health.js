const fs = require('fs');
const { cooldownRemaining } = require('../utils/stealth-http');
const path = require('path');
const state = require('../core/state');
const logger = require('../monitoring/logger');

const retailersPath = path.join(__dirname, '../config/retailers.json');

// Stale threshold: 3x the adapter's polling interval (min 5 min, max 30 min)
// This prevents false STALE alerts for slow-polling adapters like Pokemon Center (5 min interval)
const MIN_STALE_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 30 * 60 * 1000;
function getStaleThreshold(retailer) {
  const interval = retailer.intervalMs || 60000;
  return Math.max(MIN_STALE_MS, Math.min(interval * 3, MAX_STALE_MS));
}

// Adapter health: track consecutive 0-product polls (#4)
// Threshold 6 accounts for ScraperAPI rate limiting (5-min intervals) — adapters
// polling every 60s will have ~5 rate-limited polls between successful ones
const zeroProductPolls = new Map(); // retailerId → consecutive count
const ZERO_PRODUCT_THRESHOLD = 6;

// Detection health: an adapter can return a full product list built entirely from cache
// while every live check fails. Counting those polls as healthy is how Pokemon Center hid
// a day of total failure behind "found 500 products".
const zeroFreshPolls = new Map(); // retailerId → consecutive polls that fetched nothing live
const ZERO_FRESH_THRESHOLD = 3;

async function checkHealth() {
  // Merge base config with Redis overrides so enabled state is accurate
  const base = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const overrides = await state.getRetailerOverrides();
  const retailers = base.map(r => ({ ...r, ...(overrides[r.id] || {}) }));

  const composedLost = getComposition();
  const results = [];

  for (const retailer of retailers) {
    if (!retailer.enabled) continue;

    const status = await state.getRetailerStatus(retailer.id);
    const lastCheck = await state.getLastCheck(retailer.id);
    const now = Date.now();

    // A retailer we are DELIBERATELY not polling is not a retailer that is down.
    //
    // The rate-limit backoff ladder runs 30s, 60s, 2m, 5m, 15m while the stale threshold
    // floors at 5 minutes, so any shop reaching strike four was guaranteed to be declared
    // stale — the monitor was alerting on its own backoff. Over eight hours that produced 33
    // admin alerts for Infinity Cards and 18 for Hobbiesville, each a Monitor Alert, a Still
    // down reminder and a Recovery for a shop that was never actually broken.
    //
    // Extending the threshold by the remaining cooldown is self-limiting rather than a mute:
    // lastCheck only advances on a SUCCESSFUL poll, so a shop that is genuinely unreachable
    // still crosses the line once its silence outlives the cooldown, and the cooldown itself
    // is capped at 15 minutes. Transient throttling goes quiet; a real outage still alerts,
    // roughly 20 minutes in instead of 5.
    const throttledForMs = retailer.url ? cooldownRemaining(retailer.url) : 0;
    const staleThreshold = getStaleThreshold(retailer) + throttledForMs;
    const isStale = lastCheck && (now - lastCheck) > staleThreshold;
    const zeroCount = zeroProductPolls.get(retailer.id) || 0;
    const staleDataCount = zeroFreshPolls.get(retailer.id) || 0;
    const quality = parseQuality.get(retailer.id) || { emptyPolls: 0, lastRatio: null };
    // A category this store reliably carried has gone to zero — reported, but NOT counted
    // as unhealthy: it needs a human to judge whether the store stopped stocking it or we
    // stopped seeing it, and flipping the store unhealthy would mute nothing and help nobody.
    const lostCategories = (composedLost[retailer.id] || []).map(c => c.game);
    // Extending the stale window was only half the path. A throttled shop also accumulates
    // consecutive errors, and status.healthy goes false on its own — which is why Infinity
    // Cards kept alerting with "Errors: 5" after the staleness grace was in place.
    //
    // A shop whose ONLY complaint is that we are currently backing off it is not unhealthy.
    // This is bounded by isStale, which is still evaluated normally below: once the silence
    // outlives the cooldown the shop goes unhealthy regardless, so a permanently refused shop
    // is still reported rather than excused forever.
    // lastError is an OBJECT ({ message, time } — state.js writes it, alerts.js reads
    // .message), so String(status.lastError) was always "[object Object]" and this regex never
    // matched once. The whole excuse-a-throttled-store branch has been dead since it was
    // written; read the message it was always meant to read.
    const throttledOnly = !isStale && throttledForMs > 0
      && /rate.?limit|429/i.test(String(status.lastError?.message || status.lastError || ''));

    const healthy = (status.healthy || throttledOnly) && !isStale
      && zeroCount < ZERO_PRODUCT_THRESHOLD
      && staleDataCount < ZERO_FRESH_THRESHOLD
      && quality.emptyPolls < QUALITY_THRESHOLD;

    results.push({
      id: retailer.id,
      name: retailer.name,
      healthy,
      stale: isStale,
      throttledForMs,   // >0 means we are backing off on purpose, not that the shop is down
      lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
      consecutiveErrors: status.errors,
      lastError: status.lastError,
      zeroProductPolls: zeroCount,
      zeroFreshPolls: staleDataCount,
      servingStaleData: staleDataCount >= ZERO_FRESH_THRESHOLD,
      pricedRatio: quality.lastRatio,
      parserSuspect: quality.emptyPolls >= QUALITY_THRESHOLD,
      missingCategories: lostCategories,
    });
  }

  return results;
}

async function isSystemHealthy() {
  const results = await checkHealth();
  const unhealthyCount = results.filter(r => !r.healthy).length;
  return {
    healthy: unhealthyCount === 0,
    unhealthyCount,
    total: results.length,
    retailers: results,
  };
}

// Redis health check (#3)
async function checkRedisHealth() {
  try {
    const redis = state.getRedis();
    const pong = await redis.ping();
    return { healthy: pong === 'PONG', latencyMs: 0 };
  } catch (err) {
    logger.error(`Redis health check failed: ${err.message}`);
    return { healthy: false, error: err.message };
  }
}

// Called by scheduler after each successful poll
function recordProductCount(retailerId, count) {
  if (count === 0) {
    const prev = zeroProductPolls.get(retailerId) || 0;
    zeroProductPolls.set(retailerId, prev + 1);
    if (prev + 1 >= ZERO_PRODUCT_THRESHOLD) {
      logger.warn(`ADAPTER HEALTH: ${retailerId} returned 0 products for ${prev + 1} consecutive polls`);
    }
  } else {
    zeroProductPolls.set(retailerId, 0);
  }
}

// Parse-quality canary. A broken parser rarely returns nothing — it returns the right
// number of products with the fields emptied out (null prices, everything out of stock).
// Product count alone cannot see that, so we watch the shape of the result instead.
const parseQuality = new Map(); // retailerId → { emptyPolls, lastRatio }
const MIN_SAMPLE = 10;          // below this a poll is too small to judge
const PRICE_RATIO_FLOOR = 0.2;  // healthy adapters sit far above this
const QUALITY_THRESHOLD = 3;    // consecutive bad polls before we call it broken

/**
 * @param {object} products - the poll's product map, post-cap
 * @param {boolean} enabled - false for adapters whose catalogue legitimately lacks prices
 */
function recordParseQuality(retailerId, products, enabled = true) {
  // Pokemon Center publishes a 1,195-product sitemap but can only price the handful it
  // pays to check, so a zero priced-ratio there is correct, not a regression.
  if (!enabled) return;
  const values = Object.values(products || {});
  if (values.length < MIN_SAMPLE) return; // not enough to judge — stay silent

  const withPrice = values.filter(p => p && typeof p.price === 'number' && p.price > 0).length;
  const ratio = withPrice / values.length;
  const entry = parseQuality.get(retailerId) || { emptyPolls: 0, lastRatio: null };
  entry.lastRatio = parseFloat(ratio.toFixed(3));

  if (ratio >= PRICE_RATIO_FLOOR) {
    if (entry.emptyPolls >= QUALITY_THRESHOLD) {
      logger.info(`ADAPTER HEALTH: ${retailerId} parse quality recovered (${withPrice}/${values.length} priced)`);
    }
    entry.emptyPolls = 0;
  } else {
    entry.emptyPolls++;
    if (entry.emptyPolls === QUALITY_THRESHOLD) {
      logger.error(`ADAPTER HEALTH: ${retailerId} returned ${values.length} products but only ${withPrice} had a price, ${entry.emptyPolls} polls running — parser is probably broken`);
    }
  }
  parseQuality.set(retailerId, entry);
}

/**
 * Composition canary — the check for a failure that leaves no trace.
 *
 * Every other signal here watches whether a poll WORKED. None of them can see a store that
 * keeps working while quietly losing a whole category. On 2026-09-06 the string 'hat ' in the
 * non-TCG list matched "Straw Hat Crew" and classified One Piece starter decks and booster
 * boxes as clothing. Product counts stayed plausible, prices were fine, every check read
 * green, and the only symptom was drops we never alerted on. A missed drop generates no error
 * and no support ticket — the customer just stops seeing One Piece.
 *
 * So this watches the SHAPE of what we track rather than the size. Per retailer, per game:
 * once a store has reliably carried a category, its disappearance is reported.
 *
 * Learned, never hardcoded. London Drugs genuinely sells no One Piece — verified against all
 * 29,775 products in its sitemap — so a rule saying "every store must have both" would cry
 * wolf forever. A category only becomes expected after it has been seen consistently.
 *
 * Reports only. Like speed-guard, it changes nothing: autotune already demonstrated that a
 * controller free to act can act wrongly.
 */
const GAME_PATTERNS = {
  pokemon: /pokemon|pokémon/i,
  'one piece': /one piece/i,
};
const COMPOSITION_KEY = 'tcg:composition';
const BASELINE_POLLS = 20;        // observations before a category counts as expected
const MISSING_THRESHOLD = 10;     // consecutive polls at zero before we say it is gone
const composition = new Map();    // retailerId → { [game]: { seen, typical, missingStreak } }

// Known, ACCEPTED (retailer → game) disappearances the canary must NOT flag. When a store has
// deliberately stopped carrying a game, its absence is not a parser bug — and because the alert's
// de-dupe is in-memory (alerts.js), without this the alert re-fires on every restart/redeploy.
// Costco stopped carrying One Piece (confirmed 2026-09-11), so it is ignored here. Matched
// case-insensitively against the GAME_PATTERNS keys. Extend at runtime with the COMPOSITION_IGNORE
// env var, no redeploy: "retailer:game,retailer:game" (e.g. "costco:one piece,walmart:pokemon").
const COMPOSITION_IGNORE = new Map();
(function seedCompositionIgnore() {
  const add = (id, game) => {
    if (!id || !game) return;
    const key = String(id).trim().toLowerCase();
    const set = COMPOSITION_IGNORE.get(key) || new Set();
    set.add(String(game).trim().toLowerCase());
    COMPOSITION_IGNORE.set(key, set);
  };
  add('costco', 'one piece'); // Costco no longer carries One Piece — do not flag its absence
  for (const pair of String(process.env.COMPOSITION_IGNORE || '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx > 0) add(pair.slice(0, idx), pair.slice(idx + 1));
  }
})();
function isCompositionIgnored(retailerId, game) {
  const set = COMPOSITION_IGNORE.get(String(retailerId).toLowerCase());
  return !!set && set.has(String(game).toLowerCase());
}
let _compositionLoaded = false;

/** Baselines survive restarts — otherwise a redeploy resets them and this never fires. */
async function loadComposition() {
  if (_compositionLoaded) return;
  _compositionLoaded = true;
  try {
    const raw = await state.getRedis().get(COMPOSITION_KEY);
    if (!raw) return;
    for (const [id, games] of Object.entries(JSON.parse(raw))) composition.set(id, games);
    logger.info(`Composition canary: restored baselines for ${composition.size} retailer(s)`);
  } catch (err) {
    logger.warn(`Composition canary: could not restore baselines: ${err.message}`);
  }
}

async function persistComposition() {
  try {
    await state.getRedis().set(COMPOSITION_KEY, JSON.stringify(Object.fromEntries(composition)), 'EX', 86400 * 30);
  } catch {
    // Non-critical — the canary degrades to in-memory baselines
  }
}

/**
 * @param {string} retailerId
 * @param {object} products - the poll's final product map
 */
const PARTIAL_READ_RATIO = 0.3;  // a poll well below this store's own normal is a partial read

function recordComposition(retailerId, products) {
  const values = Object.values(products || {});
  if (values.length === 0) return;

  const entry = composition.get(retailerId) || {};

  // "Too small to judge" has to be relative to the STORE, not a fixed number. A flat floor of
  // 10 — borrowed from the parse-quality canary, where it is right — silently excluded every
  // store with a small catalogue: Costco returns 6 products a poll, so it never built a
  // baseline and had no cover at all. Six is not a partial read there, it is the whole shop.
  //
  // What actually indicates a partial read is a poll far below what this store normally
  // returns, so that is what gets skipped.
  entry._typicalTotal = Math.max(entry._typicalTotal || 0, values.length);
  if (values.length < entry._typicalTotal * PARTIAL_READ_RATIO) {
    composition.set(retailerId, entry);
    return;
  }
  for (const [game, re] of Object.entries(GAME_PATTERNS)) {
    const count = values.filter(p => p && re.test(String(p.name || ''))).length;
    const g = entry[game] || { seen: 0, typical: 0, missingStreak: 0 };

    if (count > 0) {
      g.seen++;
      // Rolling high-water mark, so one thin poll cannot deflate what "normal" means.
      g.typical = Math.max(g.typical, count);
      if (g.missingStreak >= MISSING_THRESHOLD) {
        logger.info(`COMPOSITION: ${retailerId} is carrying ${game} again (${count} products)`);
      }
      g.missingStreak = 0;
    } else if (g.seen >= BASELINE_POLLS) {
      // Only a category this store has reliably carried can go missing.
      g.missingStreak++;
      if (g.missingStreak === MISSING_THRESHOLD) {
        logger.error(`COMPOSITION: ${retailerId} has tracked ZERO ${game} products for ${g.missingStreak} polls ` +
          `(normally ~${g.typical}) — a scope or parser change may be silently dropping them`);
      }
    }
    entry[game] = g;
  }
  composition.set(retailerId, entry);
}

/**
 * Everything the canary has learned, for the admin API. A canary that only speaks when
 * something is wrong gives you no way to tell "all clear" from "never ran", so this reports
 * the baseline it is holding for each store and whether that baseline is mature enough to
 * judge a disappearance.
 */
function getCompositionState() {
  const out = { baselinePolls: BASELINE_POLLS, missingThreshold: MISSING_THRESHOLD, retailers: {} };
  for (const [id, games] of composition) {
    out.retailers[id] = Object.fromEntries(Object.entries(games)
      .filter(([game, g]) => game !== '_typicalTotal' && g && typeof g === 'object')
      .map(([game, g]) => [game, {
      pollsSeenWith: g.seen,
      typical: g.typical,
      armed: g.seen >= BASELINE_POLLS,   // enough history to call a disappearance
      missingStreak: g.missingStreak,
    }]));
  }
  return out;
}

/** @returns {object} retailerId → [{ game, missingPolls, typical }] for categories now missing */
function getComposition() {
  const out = {};
  for (const [id, games] of composition) {
    const lost = Object.entries(games)
      .filter(([game, g]) => game !== '_typicalTotal' && g && g.missingStreak >= MISSING_THRESHOLD
        && !isCompositionIgnored(id, game))
      .map(([game, g]) => ({ game, missingPolls: g.missingStreak, typical: g.typical }));
    if (lost.length) out[id] = lost;
  }
  return out;
}

function getParseQuality() {
  const out = {};
  for (const [id, e] of parseQuality) {
    if (e.emptyPolls > 0) out[id] = { badPolls: e.emptyPolls, pricedRatio: e.lastRatio };
  }
  return out;
}

/**
 * Called after each poll by adapters that distinguish live data from cache.
 * attempted === 0 means nothing was due this poll — neutral, not a failure.
 */
function recordFreshness(retailerId, fresh, attempted) {
  if (!attempted || attempted <= 0) return;
  if (fresh > 0) {
    if ((zeroFreshPolls.get(retailerId) || 0) >= ZERO_FRESH_THRESHOLD) {
      logger.info(`ADAPTER HEALTH: ${retailerId} is fetching live data again`);
    }
    zeroFreshPolls.set(retailerId, 0);
    return;
  }
  const next = (zeroFreshPolls.get(retailerId) || 0) + 1;
  zeroFreshPolls.set(retailerId, next);
  if (next === ZERO_FRESH_THRESHOLD) {
    logger.error(`ADAPTER HEALTH: ${retailerId} has served only cached data for ${next} consecutive polls (0/${attempted} live) — detection is DOWN even though polls succeed`);
  }
}

function getZeroFreshPolls() {
  const result = {};
  for (const [id, count] of zeroFreshPolls) {
    if (count > 0) result[id] = count;
  }
  return result;
}

function getZeroProductPolls() {
  const result = {};
  for (const [id, count] of zeroProductPolls) {
    if (count > 0) result[id] = count;
  }
  return result;
}

module.exports = {
  checkHealth, isSystemHealthy, checkRedisHealth,
  recordProductCount, getZeroProductPolls,
  recordFreshness, getZeroFreshPolls,
  recordParseQuality, getParseQuality,
  recordComposition, getComposition, getCompositionState, loadComposition, persistComposition,
};
