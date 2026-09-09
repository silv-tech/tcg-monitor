/**
 * A deliberate per-shop slowdown must actually take effect.
 *
 * clampShopInterval overrode the configured interval unconditionally. The reason given was
 * sound for values FASTER than the tier: Redis held a flat 8000ms from before the rate budget
 * existed, and honouring it would put demand back at ~4 req/sec. But the same code also
 * discarded values SLOWER than the tier — which is exactly how a shop is backed off after a
 * 429 storm. Redis held infinitycards=20000, 401games=20000, pokejeux=20000 and
 * kanzengames=120000, and every one was reverted to 9s at boot, so the infinitycards slowdown
 * had never once been in force while that shop kept going stale.
 *
 * This lived in index.js, which calls main() on load and so cannot be required from a test.
 * That is why nothing covered it. It now lives in core/shop-tiers.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { clampShopInterval } = require('../src/core/shop-tiers');
const shop = (id, intervalMs) => ({ id, adapter: 'shopify', intervalMs });

describe('shop cadence: a slower configured interval is honoured', () => {
  const cases = [
    ['infinitycards', 20000, 'backed off after 429 storms'],
    ['401games', 20000, 'backed off after 429 storms'],
    ['pokejeux', 20000, 'backed off after 429 storms'],
    ['kanzengames', 120000, 'the one configuration proven stable'],
  ];
  for (const [id, ms, why] of cases) {
    test(`${id} keeps its ${ms / 1000}s — ${why}`, () => {
      assert.strictEqual(clampShopInterval(shop(id, ms)).intervalMs, ms);
    });
  }
});

describe('shop cadence: a faster configured interval is still overridden', () => {
  test('the stale 8000ms from before the budget cannot speed a shop up', () => {
    assert.strictEqual(clampShopInterval(shop('zardocards', 8000)).intervalMs, 9000,
      'honouring this is what put demand back at ~4 req/sec');
  });

  test('an absurdly fast value cannot get through either', () => {
    assert.strictEqual(clampShopInterval(shop('hobbiesville', 500)).intervalMs, 9000);
  });

  test('a missing or junk interval falls back to the tier', () => {
    assert.strictEqual(clampShopInterval(shop('gameshack', undefined)).intervalMs, 9000);
    assert.strictEqual(clampShopInterval(shop('gameshack', NaN)).intervalMs, 9000);
  });
});

describe('shop cadence: scope', () => {
  test('non-shopify retailers are never touched', () => {
    for (const r of [
      { id: 'amazon', adapter: 'amazon', intervalMs: 6000 },
      { id: 'costco', adapter: 'costco', intervalMs: 5000 },
      { id: 'ebgames', adapter: 'ebgames', intervalMs: 5000 },
    ]) {
      assert.strictEqual(clampShopInterval(r), r, `${r.id} must pass through untouched`);
    }
  });

  test('an equal interval returns the object unchanged', () => {
    const r = shop('zardocards', 9000);
    assert.strictEqual(clampShopInterval(r), r);
  });

  test('the clamp records what it changed, for the boot log', () => {
    const out = clampShopInterval(shop('zardocards', 8000));
    assert.strictEqual(out._clampedFrom, 8000);
    assert.strictEqual(out._tier, 'active');
  });
});
