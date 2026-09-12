/**
 * The seller-cache age helper, tested against its real arithmetic.
 *
 * `delivery.js` decides whether a cached third-party verdict is evidence or staleness purely from
 * this number, so getting it wrong in either direction is a live alerting bug: report too old and a
 * 45-second-old accurate verdict is discarded (which delivers a scalper listing, because the
 * re-read is refused by scraper-api's 5-minute per-ASIN cooldown and returns nulls); report too
 * young and a month-old verdict keeps suppressing a real restock.
 *
 * WHY THE AGE IS STORED AND NOT DERIVED FROM THE TTL
 * -------------------------------------------------
 * It used to be derived: `SELLER_TTL - pttl(key)`. That welded RETENTION to TRUST, and the weld
 * broke in production on 2026-09-12.
 *
 * The reasoning at the time was sound on its own terms — a buy box is not a stable fact, so a
 * month-old verdict should not be trusted — and the TTL was cut 30d -> 6h to enforce it. But a TTL
 * does not make a verdict *distrusted*, it makes it *absent*: six hours on, `getSellerCache`
 * returned null, `cachedWouldSuppress` went false, the suppression gate never engaged at all, and
 * a missing seller FAILS OPEN by design. B0FP9ZZ68C — "Ships from Amazon / Sold by Brick Arsenal
 * LLC" — was published to the client's paid channel as a result.
 *
 * The two concerns are now separate, and both intents survive:
 *   RETENTION  a long TTL, so the evidence still exists
 *   TRUST      a real timestamp, so "45 seconds" and "20 days" are distinguishable
 *              — and delivery.js still refuses to trust ANY verdict across a stock transition
 *
 * The suites that drive delivery.js stub this function out entirely, so a mutation here would
 * otherwise pass unnoticed — hence testing the arithmetic directly.
 *
 * ioredis is replaced in the module cache BEFORE state.js is required, so no socket is ever opened
 * (a live ioredis handle hangs `node --test` indefinitely).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

let fakeValue = null;
require.cache[require.resolve('ioredis')] = {
  id: require.resolve('ioredis'),
  filename: require.resolve('ioredis'),
  loaded: true,
  exports: function FakeRedis() {
    return {
      get: async () => fakeValue,
      set: async (_k, v) => { fakeValue = v; return 'OK'; },
      pttl: async () => -2,
      on: () => {},
    };
  },
};

const state = require('../src/core/state');
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const TTL_MS = 30 * DAY_MS;   // SELLER_TTL — retention, not trust

const entry = (seller, ageMs) => JSON.stringify({ s: seller, at: Date.now() - ageMs });

describe('getSellerCacheAgeMs', () => {
  test('no key at all reports null, not an age', async () => {
    fakeValue = null;
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), null,
      'null means "no verdict", which is different from "a very old verdict"');
  });

  test('a verdict just written reports ~0', async () => {
    fakeValue = entry('Brick Arsenal LLC', 0);
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(age >= 0 && age < 1000, `expected ~0, got ${age}`);
  });

  test('a 45-second-old verdict reports 45s — the cooldown case', async () => {
    // This is the exact value that decides whether a scalper listing reaches the client.
    fakeValue = entry('Poke Moo Canada', 45_000);
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(Math.abs(age - 45_000) < 1000, `expected ~45000ms, got ${age}`);
  });

  test('a 5-hour-old verdict reports 5 hours', async () => {
    fakeValue = entry('Sparkle JAPAN', 5 * HOUR_MS);
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(Math.abs(age - 5 * HOUR_MS) < 1000, `expected ~5h, got ${age}`);
  });

  test('a 20-day-old verdict reports 20 days — it is OLD, but it still EXISTS', async () => {
    // The point of the redesign. Under the 6h TTL this verdict was simply gone, the gate went
    // quiet, and the alert shipped. Now it is present and honestly labelled as ancient, and
    // delivery.js can decide what to do with weak evidence instead of having none.
    fakeValue = entry('Brick Arsenal LLC', 20 * DAY_MS);
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(Math.abs(age - 20 * DAY_MS) < 1000, `expected ~20d, got ${age}`);
    assert.strictEqual(await state.getSellerCache('B0TEST'), 'Brick Arsenal LLC',
      'the verdict must still be readable — losing it is what published the bad alert');
  });

  test('never returns a negative age', async () => {
    fakeValue = JSON.stringify({ s: 'X', at: Date.now() + 60_000 });   // clock skew
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), 0);
  });
});

describe('legacy entries written by older builds', () => {
  test('a bare seller string is still readable', async () => {
    fakeValue = 'J & M COLLECTIBLES';
    assert.strictEqual(await state.getSellerCache('B0TEST'), 'J & M COLLECTIBLES');
  });

  test('a bare string has no recoverable age, so it reads as maximally old', async () => {
    // Unknown age must fail toward RE-READING, not toward trusting. The alternative — treating
    // it as fresh — would let an entry of unknown vintage suppress a live restock.
    fakeValue = 'Brick Arsenal LLC';
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), TTL_MS);
  });

  test('malformed JSON degrades to the legacy reading rather than throwing', async () => {
    fakeValue = '{"s":"Broken';
    assert.strictEqual(await state.getSellerCache('B0TEST'), '{"s":"Broken');
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), TTL_MS);
  });
});

describe('round trip', () => {
  test('what cacheSellerInfo writes is what getSellerCache reads', async () => {
    // Pins the two halves of the format together. They are in the same file today; the bug this
    // whole suite exists for came from one half changing without the other.
    fakeValue = null;
    await state.cacheSellerInfo('B0TEST', 'Brick Arsenal LLC');
    assert.strictEqual(await state.getSellerCache('B0TEST'), 'Brick Arsenal LLC');
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(age >= 0 && age < 1000, `a just-written verdict must read as fresh, got ${age}`);
  });

  test('an empty seller is not cached at all', async () => {
    fakeValue = null;
    await state.cacheSellerInfo('B0TEST', '');
    assert.strictEqual(fakeValue, null, 'caching "" would read back as a verdict of unknown shape');
  });
});
