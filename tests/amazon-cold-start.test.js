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
    assert.strictEqual(a._hydrated, false, 'a failed load is NOT a completed one');
  });

  /**
   * This assertion used to read `_hydrated === true`, justified as "it must not retry forever on
   * every poll". The concern was right and the mechanism was wrong: the flag was set BEFORE the
   * try, so ONE transient failure disabled hydration for the life of the process — and a process
   * that never re-reads Redis is exactly the cold start this whole file exists to prevent. The
   * three tests below keep the original concern (bounded work) while fixing the hole.
   */
  test('a transient failure is retried — one bad poll must not strand the process', async () => {
    let calls = 0;
    state.getAllProducts = async () => {
      if (++calls === 1) throw new Error('ECONNREFUSED');
      return { B0A: stored({ sku: 'B0A' }), B0B: stored({ sku: 'B0B' }) };
    };
    const a = adapter();
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 0, 'poll 1: Redis was down');
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 2, 'poll 2: Redis recovered, so the catalogue loads');
    assert.strictEqual(a._hydrated, true);
  });

  test('retries are bounded — a dead Redis is not re-read on every poll forever', async () => {
    let calls = 0;
    state.getAllProducts = async () => { calls++; throw new Error('ECONNREFUSED'); };
    const a = adapter();
    for (let i = 0; i < 20; i++) await a._hydrateFromRedis();
    assert.ok(calls <= 5, `at most 5 attempts, got ${calls}`);
    assert.strictEqual(a._hydrated, false, 'and it stays cold rather than pretending it loaded');
  });

  test('overlapping polls share ONE hydration rather than racing the map', async () => {
    let calls = 0;
    state.getAllProducts = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { B0A: stored({ sku: 'B0A' }), B0B: stored({ sku: 'B0B' }) };
    };
    const a = adapter();
    // Setting the flag before the await used to provide single-flight for free; now that it is
    // only set on success, the in-flight promise is what stops two polls hydrating concurrently.
    await Promise.all([a._hydrateFromRedis(), a._hydrateFromRedis(), a._hydrateFromRedis()]);
    assert.strictEqual(calls, 1, 'one Redis read, not three');
    assert.strictEqual(a._knownProducts.size, 2);
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
