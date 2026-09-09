/**
 * Shop poll cadence: which interval each Shopify shop actually runs at.
 *
 * Lived in index.js, which calls main() unconditionally and so cannot be required from a test.
 * That is not a small detail for this particular function: it silently reverted deliberate
 * per-shop slowdowns for weeks and nothing could cover it. Moved here so it can be.
 */

const logger = require('../monitoring/logger');

// Every tier is env-tunable so a bad cadence is a one-command undo rather than a deploy.
//
// The budget ceiling was originally found by moving the global rate and watching for five
// minutes at each step. That was too short: 4.2 req/sec looked clean at every check and then
// 429s reappeared roughly an hour later. Shopify's throttle accumulates over a much longer
// window than a single observation.
const tierMs = (envVar, fallback) => {
  const v = Number(process.env[envVar]);
  return Number.isFinite(v) && v >= 1000 ? v : fallback;
};

/**
 * Shops promoted to the fast interval one small batch at a time, by id. Promotion is
 * incremental and reversible: add a few ids, let them soak, confirm nothing degraded, add more.
 * A bad batch costs one step back rather than every shop.
 */
const promotedIds = () => new Set(
  String(process.env.SHOP_FAST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

// The quiet tier is empty but kept: it is the control surface for backing ONE shop off without
// slowing the rest, which is a better first move than a global slowdown.
const shopTiers = () => ({
  active: {
    intervalMs: tierMs('SHOP_ACTIVE_MS', 9000),
    ids: new Set(['pokejeux', 'infinitycards', 'zardocards', '401games', 'hobbiesville',
      'remicardtrader', 'kanzengames', 'gameshack']),
  },
  quiet: { intervalMs: tierMs('SHOP_QUIET_MS', 9000), ids: new Set() },
  medium: { intervalMs: tierMs('SHOP_MEDIUM_MS', 9000), ids: null },
});

/**
 * Overrides a configured interval that is FASTER than the tier; honours one that is SLOWER.
 *
 * The override exists because the intervals in Redis were a flat 8000ms left over from before
 * the rate budget existed, and honouring those would put demand back at ~4 req/sec. That
 * reasoning only ever applied to values faster than the tier. Applied to slower ones it threw
 * away deliberate per-shop slowdowns: Redis held infinitycards=20000, 401games=20000,
 * pokejeux=20000 and kanzengames=120000 — the exact backing-off done to stop their 429 storms —
 * and every one was reverted to 9s at boot. The infinitycards slowdown had never once been in
 * force, which is a large part of why that shop kept going stale.
 *
 * Taking the slower of the two keeps the original protection (a stale fast value cannot speed a
 * shop up) while making the documented control surface actually work.
 */
function clampShopInterval(retailer) {
  if (!retailer || retailer.adapter !== 'shopify') return retailer;

  const tiers = shopTiers();
  const promoted = promotedIds();
  const tier = (promoted.has(retailer.id) || tiers.active.ids.has(retailer.id)) ? 'active'
    : tiers.quiet.ids.has(retailer.id) ? 'quiet'
      : 'medium';

  const tierInterval = tiers[tier].intervalMs;
  const configured = Number(retailer.intervalMs);
  const slowedByOperator = Number.isFinite(configured) && configured > tierInterval;
  const intervalMs = slowedByOperator ? configured : tierInterval;

  if (slowedByOperator) {
    logger.info(`${retailer.id}: honouring configured ${Math.round(configured / 1000)}s `
      + `(slower than the ${tier} tier's ${Math.round(tierInterval / 1000)}s)`);
  }
  if (intervalMs === retailer.intervalMs) return retailer;
  return { ...retailer, intervalMs, _tier: tier, _clampedFrom: retailer.intervalMs };
}

module.exports = { clampShopInterval, shopTiers, tierMs };
