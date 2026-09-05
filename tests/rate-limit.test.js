/**
 * Regression tests for the 2026-09-05 rate-limit storm.
 *
 * Thirty Shopify shops on one IP took 202 rate-limit rejections in a 23-second window and
 * produced, downstream, false "PARSER SUSPECT — 0% of products have a price" alerts and
 * repeated alert-flood suppressions. Three separate defects combined:
 *
 *   1. A 429 changed nothing — with maxRetries:1 the Retry-After sleep was unreachable, so
 *      the next poll walked straight back into the block.
 *   2. A throttled fetch returned {} — indistinguishable from a shop with no products.
 *   3. Polls were phase-aligned — a flat 3000ms stagger against an 8000ms interval leaves
 *      only 8 distinct slots, so shops fired in bursts rather than spread out.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isRateLimited, cooldownRemaining, _resetCooldowns } = require('../src/utils/stealth-http');

describe('rate limit: host cooldown', () => {
  test('a fresh host has no cooldown', () => {
    _resetCooldowns();
    assert.strictEqual(cooldownRemaining('https://example.myshopify.com/products.json'), 0);
  });

  test('rate-limit and cooldown errors are both recognised as throttling', () => {
    assert.ok(isRateLimited(new Error('Rate limited (429): https://x.ca/products.json')));
    assert.ok(isRateLimited(new Error('Cooling down 5s after 429: https://x.ca/products.json')));
  });

  test('a block or parse failure is NOT treated as throttling', () => {
    // This distinction is the whole point: only a throttle should skip the poll silently.
    // A block still deserves to surface as an error.
    assert.ok(!isRateLimited(new Error('Blocked after 3 stealth attempts: 403')));
    assert.ok(!isRateLimited(new Error('Unexpected token < in JSON')));
    assert.ok(!isRateLimited(undefined));
  });
});

describe('rate limit: scheduler phase spread', () => {
  // The exact arithmetic that caused the storm, and the arithmetic that fixes it.
  const phasesFor = (offsets, intervalMs) => new Set(offsets.map((o) => o % intervalMs));

  test('the old flat 3000ms stagger collapses 30 shops onto 8 phases', () => {
    const old = Array.from({ length: 30 }, (_, i) => i * 3000);
    assert.strictEqual(phasesFor(old, 8000).size, 8, 'this is the bug: 30 shops, 8 slots');
  });

  test('dividing the period gives every adapter its own slot', () => {
    const n = 30;
    const intervalMs = 8000;
    const slot = intervalMs / n;
    const spread = Array.from({ length: n }, (_, i) => Math.round(i * slot));
    assert.strictEqual(phasesFor(spread, intervalMs).size, n, 'every shop gets a distinct phase');
  });

  test('spread offsets never exceed the interval, so no poll is delayed a full cycle', () => {
    const n = 7;
    const intervalMs = 5000;
    const slot = intervalMs / n;
    for (let i = 0; i < n; i++) {
      assert.ok(Math.round(i * slot) < intervalMs);
    }
  });

  test('a single adapter in a group starts immediately', () => {
    const slot = 8000 / 1;
    assert.strictEqual(Math.round(0 * slot), 0);
  });
});

describe('rate limit: a throttled shop is not an empty shop', () => {
  const ShopifyAdapter = require('../src/adapters/shopify');

  function makeAdapter() {
    return new ShopifyAdapter({
      id: 'testshop',
      name: 'Test Shop',
      url: 'https://testshop.example',
      type: 'shopify',
      intervalMs: 30000,
      searchKeywords: [],
      collections: [],
    });
  }

  test('throws instead of reporting a catalogue of nothing', async () => {
    const adapter = makeAdapter();
    adapter.fetchAllProducts = async () => {
      throw new Error('Rate limited (429): https://testshop.example/products.json');
    };
    await assert.rejects(
      () => adapter.fetchProducts(),
      /rate limited/i,
      'a 429 must fail the poll, not report zero products',
    );
  });

  test('a genuinely empty shop still returns empty rather than throwing', async () => {
    const adapter = makeAdapter();
    adapter.fetchAllProducts = async () => { /* shop really has nothing matching */ };
    const products = await adapter.fetchProducts();
    assert.deepStrictEqual(products, {}, 'an honestly empty result is not an error');
  });

  test('a throttle that still yielded products keeps them', async () => {
    // Partial success: one page 429'd, an earlier one succeeded. Better to report what we
    // have than to throw away a real reading.
    const adapter = makeAdapter();
    adapter.fetchAllProducts = async (products) => {
      products['sku-1'] = { sku: 'sku-1', name: 'Booster Box', price: 49.99, inStock: true };
      throw new Error('Rate limited (429): page 2');
    };
    const products = await adapter.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 1);
  });
});

describe('rate limit: escalating backoff', () => {
  const {
    setCooldown, clearStrikes, cooldownRemaining, _resetCooldowns, BACKOFF_LADDER_MS,
  } = require('../src/utils/stealth-http');

  const URL_A = 'https://escalate-a.example/products.json';

  test('consecutive 429s climb the ladder', () => {
    _resetCooldowns();
    const seen = [];
    for (let i = 0; i < BACKOFF_LADDER_MS.length; i++) {
      seen.push(setCooldown(URL_A, 5000).ms);
    }
    assert.deepStrictEqual(seen, BACKOFF_LADDER_MS, 'each strike doubles the quiet period');
  });

  test('the ladder caps rather than growing without bound', () => {
    _resetCooldowns();
    let last = 0;
    for (let i = 0; i < 20; i++) last = setCooldown(URL_A, 5000).ms;
    assert.strictEqual(last, BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1]);
  });

  test('a 5s Retry-After no longer produces a 5s cooldown', () => {
    // The exact defect: Retry-After:5 let the next 45s poll walk straight back in.
    _resetCooldowns();
    const { ms } = setCooldown(URL_A, 5000);
    assert.ok(ms >= 30000, `expected >=30s of quiet, got ${ms}ms`);
  });

  test('a host asking for LONGER than the ladder is still honoured', () => {
    _resetCooldowns();
    const { ms } = setCooldown('https://patient.example/x.json', 600000);
    assert.strictEqual(ms, 600000);
  });

  test('cooldown is per host — one throttled shop does not mute the others', () => {
    _resetCooldowns();
    setCooldown('https://shop-one.example/products.json', 5000);
    assert.ok(cooldownRemaining('https://shop-one.example/products.json') > 0);
    assert.strictEqual(cooldownRemaining('https://shop-two.example/products.json'), 0);
  });

  test('a success clears the ladder so a recovered shop starts fresh', () => {
    _resetCooldowns();
    setCooldown(URL_A, 5000);
    setCooldown(URL_A, 5000);
    clearStrikes(URL_A);
    assert.strictEqual(cooldownRemaining(URL_A), 0, 'cooldown lifted');
    assert.strictEqual(setCooldown(URL_A, 5000).ms, BACKOFF_LADDER_MS[0], 'back to rung one');
  });
});
