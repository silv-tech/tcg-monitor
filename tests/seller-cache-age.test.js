/**
 * The seller-cache age helper, tested against its real arithmetic.
 *
 * `delivery.js` decides whether a cached third-party verdict is evidence or staleness purely from
 * this number, so getting it wrong in either direction is a live alerting bug: report too old and a
 * 45-second-old accurate verdict is discarded (which delivers a scalper listing, because the
 * re-read is refused by scraper-api's 5-minute per-ASIN cooldown and returns nulls); report too
 * young and a month-old verdict keeps suppressing a real restock.
 *
 * Age is derived from the key's remaining TTL rather than a stored timestamp, so the cache format
 * is unchanged and entries written by older builds still work. That makes the arithmetic worth a
 * direct test — the suites that drive delivery.js stub this function out entirely, so a mutation
 * here would otherwise pass unnoticed.
 *
 * ioredis is replaced in the module cache BEFORE state.js is required, so no socket is ever opened
 * (a live ioredis handle hangs `node --test` indefinitely).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

let fakePttl = -2;
require.cache[require.resolve('ioredis')] = {
  id: require.resolve('ioredis'),
  filename: require.resolve('ioredis'),
  loaded: true,
  exports: function FakeRedis() {
    return {
      pttl: async () => fakePttl,
      get: async () => null,
      set: async () => 'OK',
      on: () => {},
    };
  },
};

const state = require('../src/core/state');
const HOUR_MS = 3600_000;
const TTL_MS = 6 * HOUR_MS;   // SELLER_TTL

describe('getSellerCacheAgeMs', () => {
  test('no key at all reports null, not an age', async () => {
    fakePttl = -2;   // redis: key does not exist
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), null,
      'null means "no verdict", which is different from "a very old verdict"');
  });

  test('a verdict just written reports ~0', async () => {
    fakePttl = TTL_MS;
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(age >= 0 && age < 1000, `expected ~0, got ${age}`);
  });

  test('a 45-second-old verdict reports 45s — the cooldown case', async () => {
    // This is the exact value that decides whether a scalper listing reaches the client.
    fakePttl = TTL_MS - 45_000;
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(Math.abs(age - 45_000) < 1000, `expected ~45000ms, got ${age}`);
  });

  test('a 5-hour-old verdict reports 5 hours', async () => {
    fakePttl = TTL_MS - 5 * HOUR_MS;
    const age = await state.getSellerCacheAgeMs('B0TEST');
    assert.ok(Math.abs(age - 5 * HOUR_MS) < 1000, `expected ~5h, got ${age}`);
  });

  test('a key with no expiry is treated as maximally old, never as fresh', async () => {
    fakePttl = -1;   // redis: exists, no TTL — should not happen, must not read as "just written"
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), TTL_MS,
      'an unknown age must fail toward re-reading, not toward trusting');
  });

  test('never returns a negative age', async () => {
    fakePttl = TTL_MS + 60_000;   // clock skew / a TTL longer than expected
    assert.strictEqual(await state.getSellerCacheAgeMs('B0TEST'), 0);
  });
});
