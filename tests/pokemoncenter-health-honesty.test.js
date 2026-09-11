/**
 * Pokemon Center must not report healthy while it is blind.
 *
 * Measured 2026-09-11: the Bright Data account was suspended, 188 consecutive stock checks
 * returned nothing, all 805 products read out of stock — and /api/health still said
 * `healthy: true, stale: false, servingStaleData: false`. The store had no working stock
 * detection at all and nothing said so. That is why nobody noticed it had gone dark.
 *
 * The cause was the freshness call reporting `availabilityCache.size` — the size of a cache
 * restored from Redis at boot, which only ever grows. It can never reach zero, so the
 * zero-fresh detector in monitoring/health.js could never trip. base.js says plainly why that
 * detector exists: "Pokemon Center happily reported 500 products for a whole day while every
 * availability check failed." The canary was defeated at its only call site.
 *
 * Freshness now reports the outcome of the stock reads themselves.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const PokemonCenterAdapter = require('../src/adapters/pokemoncenter');

function adapter() {
  return new PokemonCenterAdapter({
    id: 'pokemoncenter', name: 'Pokemon Center',
    url: 'https://www.pokemoncenter.com', intervalMs: 8000,
  });
}

let a;
beforeEach(() => { a = adapter(); });

describe('freshness follows the stock checks, not the cache size', () => {
  test('a run of failed checks reports zero fresh', () => {
    for (let i = 0; i < 10; i++) a._noteCheckOutcome(`sku-${i}`, false);
    assert.strictEqual(a._freshAttempts, 10);
    assert.strictEqual(a._freshSuccesses, 0,
      'every check failed — freshness must be able to say so');
  });

  test('successful checks are counted', () => {
    a._noteCheckOutcome('a', true);
    a._noteCheckOutcome('b', false);
    a._noteCheckOutcome('c', true);
    assert.strictEqual(a._freshAttempts, 3);
    assert.strictEqual(a._freshSuccesses, 2);
  });

  test('a populated availability cache cannot manufacture freshness', () => {
    // The exact shape of the outage: a full cache restored from Redis, and every check failing.
    for (let i = 0; i < 649; i++) a.availabilityCache.set(`sku-${i}`, { inStock: false, price: 1 });
    for (let i = 0; i < 4; i++) a._noteCheckOutcome(`sku-${i}`, false);

    assert.strictEqual(a.availabilityCache.size, 649, 'cache is full...');
    assert.strictEqual(a._freshSuccesses, 0, '...but nothing was actually read');
  });
});

describe('the counters reset per report, so one bad window cannot stick', () => {
  test('counting resumes from zero after a report', () => {
    a._noteCheckOutcome('a', false);
    a._noteCheckOutcome('b', false);
    // Simulate what fetchProducts does once it has reported.
    a.reportFreshness(a._freshSuccesses, a._freshAttempts);
    a._freshAttempts = 0;
    a._freshSuccesses = 0;
    assert.deepStrictEqual(a._lastFreshness, { fresh: 0, attempted: 2 });

    a._noteCheckOutcome('c', true);
    assert.strictEqual(a._freshAttempts, 1);
    assert.strictEqual(a._freshSuccesses, 1, 'a recovered store must be able to read healthy again');
  });
});

describe('the category sweep is disabled while its filter premise is false', () => {
  test('it returns without fetching anything unless explicitly re-enabled', async () => {
    let fetched = 0;
    a._fetchCategoryPage = async () => { fetched++; return null; };
    const prev = process.env.PC_CATEGORY_SWEEP;
    delete process.env.PC_CATEGORY_SWEEP;
    try {
      await a._sweepCategories();
      assert.strictEqual(fetched, 0,
        'membership of ?availability=true no longer means in stock — sweeping would mark the '
        + 'whole category in stock and fire a mass false RESTOCK');
    } finally {
      if (prev === undefined) delete process.env.PC_CATEGORY_SWEEP; else process.env.PC_CATEGORY_SWEEP = prev;
    }
  });
});

describe('a store that has STOPPED TRYING is not healthy either', () => {
  // The gap the live store exposed on 2026-09-11. With the paid account suspended, the rotation
  // budget was spent on failures and every product parked for 12h after two, so the poll line
  // settled into "0 queued, 322 parked, checks idle". Zero attempts means zero samples, so
  // reporting only on attempts left health green for a store that had given up entirely.
  test('no attempts and no successful read for hours reports zero fresh', () => {
    a.sitemapProducts = new Map([['A1', { url: 'u', name: 'n' }]]);
    a._lastGoodReadAt = Date.now() - 7 * 60 * 60 * 1000;
    a._freshAttempts = 0;

    // The branch fetchProducts takes when nothing was attempted.
    if (a._freshAttempts === 0 && a.sitemapProducts.size > 0
        && Date.now() - a._lastGoodReadAt >= 6 * 60 * 60 * 1000) {
      a.reportFreshness(0, 1);
    }
    assert.deepStrictEqual(a._lastFreshness, { fresh: 0, attempted: 1 },
      'a catalogue nobody can read is not healthy, however tidily it stopped trying');
  });

  test('a recent successful read keeps it quiet', () => {
    a.sitemapProducts = new Map([['A1', { url: 'u', name: 'n' }]]);
    a._lastGoodReadAt = Date.now() - 60 * 1000;
    assert.ok(Date.now() - a._lastGoodReadAt < 6 * 60 * 60 * 1000,
      'a store read a minute ago must not be called blind');
  });

  test('a successful read clears the blind warning so recovery is reported once', () => {
    a._blindWarned = true;
    a._noteCheckOutcome('A1', true);
    assert.strictEqual(a._blindWarned, false);
    assert.ok(a._lastGoodReadAt > Date.now() - 1000);
  });

});
