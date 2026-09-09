/**
 * A restart must not look like the catalogue was delisted.
 *
 * `_knownProducts` is in-memory only. Without hydration a cold start reports a handful of
 * products while Redis still holds hundreds, poll-adapter's stale cleanup concludes the rest are
 * gone and writes inStock:false across the catalogue, and the next poll — finding them again on
 * the very same search pages — fires RESTOCK for every one.
 *
 * Measured on the 2026-09-09 17:04 deploy:
 *
 *   17:04:11  process start
 *   17:04:47  322 stale products — 322 confirmed OOS      <- false, written to Redis
 *   17:04:54  37 event(s) detected
 *   17:04:54.396  muting amazon for 10min — 21 alerts in 0s
 *   17:04:54.396  all three restock escapes spent, same millisecond
 *   17:17:36  unmuted — 75 alert(s) were suppressed
 *
 * The stale counter then decayed 285 -> 208 as each falsely-dead product was rediscovered: 77
 * recoveries against 75 suppressed + 3 escaped. Every deploy reproduced this, and deploys
 * cluster exactly when someone is watching for a drop.
 *
 * Shopify (_loadHandleIndex) and EB Games already hydrate. Amazon was the last one that did not.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
// The adapter reaches for Redis on hydration (catalogue + identity denylist); an open
// connection keeps this test process alive after every assertion has passed.
state.getRedis = () => null;
// state.js calls its OWN internal getRedis(), so stubbing the exported getRedis does not stop
// a real connection opening — the exported functions the adapter calls must be stubbed instead.
state.getDeniedIdentities = async () => new Map();
state.denyIdentity = async () => {};
const AmazonAdapter = require('../src/adapters/amazon');

const CFG = {
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
  adapter: 'amazon', intervalMs: 6000, proxyTier: 'isp', enabled: true, watchlist: [],
};

const stored = (over = {}) => ({
  sku: 'B0TEST0001', name: 'Pokemon TCG: Mega Evolution Pitch Black Elite Trainer Box',
  price: 69.99, inStock: true, canAddToCart: true, retailerId: 'amazon', ...over,
});

let redisProducts;
beforeEach(() => {
  redisProducts = {};
  state.getAllProducts = async () => redisProducts;
});

function adapter() {
  const a = new AmazonAdapter(CFG);
  return a;
}

describe('the catalogue survives a restart', () => {
  test('stored products are loaded into the in-memory map', async () => {
    redisProducts = { B0A: stored({ sku: 'B0A' }), B0B: stored({ sku: 'B0B' }) };
    const a = adapter();
    assert.strictEqual(a._knownProducts.size, 0, 'precondition: a fresh process starts empty');
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 2,
      'without this the first poll looks like the catalogue was delisted');
  });

  test('hydration runs once per process, not once per poll', async () => {
    let calls = 0;
    state.getAllProducts = async () => { calls++; return { B0A: stored({ sku: 'B0A' }) }; };
    const a = adapter();
    await a._hydrateFromRedis();
    await a._hydrateFromRedis();
    await a._hydrateFromRedis();
    assert.strictEqual(calls, 1, 're-reading the whole catalogue every 6s would be its own problem');
  });

  test('a live product already in memory is never overwritten by a stale stored copy', async () => {
    redisProducts = { B0A: stored({ sku: 'B0A', price: 1.99, inStock: false }) };
    const a = adapter();
    const live = stored({ sku: 'B0A', price: 69.99, inStock: true });
    a._knownProducts.set('B0A', live);
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.get('B0A').price, 69.99, 'fresh data must win');
    assert.strictEqual(a._knownProducts.get('B0A').inStock, true);
  });

  test('out-of-scope rows written by older builds are not resurrected', async () => {
    redisProducts = {
      B0A: stored({ sku: 'B0A' }),
      B0JUNK: stored({ sku: 'B0JUNK', name: 'PopSockets PopGrip Phone Holder' }),
    };
    const a = adapter();
    await a._hydrateFromRedis();
    assert.ok(a._knownProducts.has('B0A'));
    assert.ok(!a._knownProducts.has('B0JUNK'),
      'Redis holds rows written under older scope rules — re-apply the filter on the way in');
  });

  test('a row with no name is skipped rather than crashing the poll', async () => {
    redisProducts = { B0A: stored({ sku: 'B0A' }), B0BAD: { sku: 'B0BAD' }, B0NULL: null };
    const a = adapter();
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 1);
  });
});

describe('hydration can fail without taking the poll down', () => {
  test('a Redis error leaves the adapter usable', async () => {
    state.getAllProducts = async () => { throw new Error('ECONNREFUSED'); };
    const a = adapter();
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 0, 'degraded, not broken — the cursor rebuilds it');
    assert.strictEqual(a._hydrated, true, 'and it must not retry forever on every poll');
  });

  test('a hanging Redis does not hang the poll', async () => {
    state.getAllProducts = () => new Promise(() => {});   // never settles
    const a = adapter();
    const started = Date.now();
    await a._hydrateFromRedis();
    assert.ok(Date.now() - started < 9000, 'the first poll must not wait on an unreachable Redis');
  });

  test('an empty Redis is a normal first run, not an error', async () => {
    redisProducts = {};
    const a = adapter();
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 0);
  });
});
