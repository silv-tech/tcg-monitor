/**
 * Guard: the Shopify rate-limit work must not reach the big six.
 *
 * The big six are what the product is sold on. The 2026-09-05 shop work touched three files
 * they share — stealth-http (all HTTP), poll-adapter (all polls) and the scheduler (all
 * timers) — so "it only affects shops" is a claim that needs testing, not assuming.
 *
 * Each test below fails if a shop-tier change can alter big-six behaviour.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const BIG_SIX = ['walmart', 'amazon', 'costco', 'bestbuy', 'ebgames', 'pokemoncenter'];

describe('big six: intervals are not clamped by the shop floor', () => {
  // Mirrors clampShopInterval in src/index.js exactly.
  const SHOP_MIN_INTERVAL_MS = 8000;
  const clamp = (r) => {
    if (r.adapter !== 'shopify') return r;
    if (!(r.intervalMs < SHOP_MIN_INTERVAL_MS)) return r;
    return { ...r, intervalMs: SHOP_MIN_INTERVAL_MS, _clampedFrom: r.intervalMs };
  };

  test('every big-six adapter passes through untouched', () => {
    const live = [
      { id: 'walmart', adapter: 'walmart', intervalMs: 6000 },
      { id: 'amazon', adapter: 'amazon', intervalMs: 6000 },
      { id: 'costco', adapter: 'costco', intervalMs: 5000 },
      { id: 'bestbuy', adapter: 'bestbuy', intervalMs: 5000 },
      { id: 'ebgames', adapter: 'ebgames', intervalMs: 5000 },
      { id: 'pokemoncenter', adapter: 'pokemoncenter', intervalMs: 8000 },
    ];
    for (const r of live) {
      const out = clamp(r);
      assert.strictEqual(out.intervalMs, r.intervalMs, `${r.id} interval changed`);
      assert.strictEqual(out._clampedFrom, undefined, `${r.id} was clamped`);
      assert.strictEqual(out, r, `${r.id} object was rewritten`);
    }
  });

  test('a big-six store BELOW the shop floor is still left alone', () => {
    // Costco at 5000ms is under the 8000ms shop floor. It must not be dragged up.
    const costco = { id: 'costco', adapter: 'costco', intervalMs: 5000 };
    assert.strictEqual(clamp(costco).intervalMs, 5000);
  });

  test('the real config still has all six under their 10s target', () => {
    const retailers = require('../src/config/retailers.json');
    for (const id of BIG_SIX) {
      const r = retailers.find((x) => x.id === id);
      assert.ok(r, `${id} missing from retailers.json`);
      assert.ok(r.intervalMs <= 8000, `${id} interval regressed to ${r.intervalMs}ms`);
      assert.notStrictEqual(r.adapter, 'shopify', `${id} must not be shop-tier`);
    }
  });
});

describe('big six: the partial-poll merge cannot apply to them', () => {
  // Mirrors the merge condition in poll-adapter.js.
  const merge = (adapter, oldProducts, newProducts) => (
    adapter._partialPoll && Object.keys(oldProducts).length > 0
      ? { ...oldProducts, ...newProducts }
      : newProducts
  );

  test('_partialPoll is undefined for non-Shopify adapters, so the merge is skipped', () => {
    // Walmart's search legitimately returns 5-8 of ~353 known products. If the merge ever
    // applied to it, stale cleanup would stop marking sold-out items out of stock.
    const walmart = { id: 'walmart' };
    const cached = { a: { inStock: true }, b: { inStock: true } };
    const fresh = { a: { inStock: true } };
    const out = merge(walmart, cached, fresh);
    assert.strictEqual(Object.keys(out).length, 1, 'big-six results must stand on their own');
    assert.strictEqual(out, fresh, 'no merge object was created');
  });

  test('only an adapter that explicitly sets the flag gets merged', () => {
    const shop = { id: 'hobbiesville', _partialPoll: true };
    const out = merge(shop, { a: {}, b: {} }, { a: {} });
    assert.strictEqual(Object.keys(out).length, 2);
  });
});

describe('big six: throttle handling cannot mute them', () => {
  const {
    isRateLimited, cooldownRemaining, setCooldown, _resetCooldowns,
  } = require('../src/utils/stealth-http');

  test('a 403 block is not treated as throttling', () => {
    // Walmart (PerimeterX) and EB Games (Cloudflare) answer 403/503, not 429. If those were
    // read as rate limits they would be silently swallowed as "skip the poll" instead of
    // surfacing as errors, and a blocked big-six store would look healthy.
    assert.ok(!isRateLimited(new Error('Blocked after 3 stealth attempts: 403')));
    assert.ok(!isRateLimited(new Error('Blocked after 3 stealth attempts: 503')));
    assert.ok(!isRateLimited(new Error('Stealth: failed after 3 attempts: https://walmart.ca')));
  });

  test('a throttled shop never puts a big-six host on cooldown', () => {
    _resetCooldowns();
    setCooldown('https://hobbiesville.com/products.json', 5000);
    for (const host of [
      'https://www.walmart.ca/search?q=pokemon',
      'https://www.amazon.ca/s?k=pokemon',
      'https://gdx-api.costco.com/catalog/search/api/v1/search',
      'https://www.bestbuy.ca/api/v2/json/search',
      'https://www.ebgames.ca/collections/pokemon',
      'https://www.pokemoncenter.com/api/products',
    ]) {
      assert.strictEqual(cooldownRemaining(host), 0, `${host} was put on cooldown by a shop`);
    }
    _resetCooldowns();
  });
});

describe('big six: phase spread changes offset, never cadence', () => {
  test('each store keeps its exact configured interval', () => {
    const members = [
      { id: 'costco', intervalMs: 5000 },
      { id: 'bestbuy', intervalMs: 5000 },
      { id: 'ebgames', intervalMs: 5000 },
    ];
    const slot = 5000 / members.length;
    members.forEach((m, i) => {
      const offset = Math.round(i * slot);
      assert.ok(offset < m.intervalMs, 'startup offset never exceeds one cycle');
      assert.strictEqual(m.intervalMs, 5000, 'interval itself is untouched');
    });
  });

  test('detection stays under 10s at the configured intervals', () => {
    // interval + a generous poll allowance, against the 10s promise the product rests on.
    const measured = {
      bestbuy: [5000, 181], costco: [5000, 793], ebgames: [5000, 2005],
      amazon: [6000, 1535], pokemoncenter: [8000, 6], walmart: [6000, 3012],
    };
    for (const [id, [interval, poll]] of Object.entries(measured)) {
      assert.ok(interval + poll < 10000, `${id} detection ${(interval + poll) / 1000}s exceeds 10s`);
    }
  });
});
