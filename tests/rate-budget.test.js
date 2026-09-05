/**
 * Global outbound rate budget.
 *
 * Every rate-limit failure in this system had the same shape: each store's own cadence looked
 * fine and the SUM did not. Per-store limits cannot express that, which is why 31 shops each
 * polling "only" every 8 seconds still put ~4 req/sec (peaking ~7 during sweeps) on one IP and
 * kept every one of them rate-limited.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const rateBudget = require('../src/utils/rate-budget');
const { TokenBucket } = rateBudget;

afterEach(() => rateBudget._reset());

describe('rate budget: pacing', () => {
  test('burst capacity is granted immediately', async () => {
    const b = new TokenBucket('t', 100, 3);
    const t = Date.now();
    assert.strictEqual(await b.acquire(1000), true);
    assert.strictEqual(await b.acquire(1000), true);
    assert.strictEqual(await b.acquire(1000), true);
    assert.ok(Date.now() - t < 50, 'burst should not wait');
  });

  test('past the burst, requests are paced at the configured rate', async () => {
    const b = new TokenBucket('t', 20, 1); // 20/sec => ~50ms apart
    await b.acquire(1000);
    const t = Date.now();
    await b.acquire(1000);
    await b.acquire(1000);
    const elapsed = Date.now() - t;
    assert.ok(elapsed >= 70, `expected pacing, got ${elapsed}ms`);
  });

  test('a caller gives up rather than hanging a poll forever', async () => {
    const b = new TokenBucket('t', 1, 1);
    await b.acquire(1000);
    const t = Date.now();
    const granted = await b.acquire(120);
    assert.strictEqual(granted, false, 'should time out, not hang');
    assert.ok(Date.now() - t < 600, 'and give up promptly');
  });

  test('waiters are served in order, so no shop is starved by its neighbours', async () => {
    const b = new TokenBucket('t', 50, 1);
    await b.acquire(500);
    const order = [];
    await Promise.all([1, 2, 3, 4].map(async (i) => {
      const ok = await b.acquire(3000);
      if (ok) order.push(i);
    }));
    assert.deepStrictEqual(order, [1, 2, 3, 4], 'FIFO');
  });

  test('a quiet period earns back burst capacity, but never beyond the cap', async () => {
    const b = new TokenBucket('t', 1000, 4);
    for (let i = 0; i < 4; i++) await b.acquire(500);
    await new Promise((r) => setTimeout(r, 60));
    b._refill(Date.now());
    assert.ok(b.tokens <= 4, `tokens ${b.tokens} exceeded burst cap`);
    assert.ok(b.tokens > 1, 'refilled during the quiet period');
  });
});

describe('rate budget: aggregate is what it actually bounds', () => {
  test('31 shops sharing 2.5/sec are paced to roughly that in total', async () => {
    // The scenario that caused the outage, at the configured budget.
    const b = new TokenBucket('shopify', 2.5, 5);
    const t = Date.now();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => b.acquire(10000)),
    );
    const elapsed = (Date.now() - t) / 1000;
    assert.ok(results.every(Boolean), 'all eventually granted');
    // 12 requests, 5 free from burst => 7 paced at 2.5/sec => ~2.8s
    assert.ok(elapsed >= 2.0, `expected real pacing, took only ${elapsed}s`);
    const effectiveRate = 12 / Math.max(elapsed, 0.001);
    assert.ok(effectiveRate < 6, `effective rate ${effectiveRate.toFixed(1)}/sec too high`);
  });
});

describe('rate budget: wiring', () => {
  test('an unconfigured budget imposes no limit, so callers stay simple', async () => {
    rateBudget._reset();
    assert.strictEqual(await rateBudget.acquire('not-configured', 10), true);
  });

  test('configure then acquire uses the bucket', async () => {
    rateBudget._reset();
    rateBudget.configure('shopify', 1, 1);
    assert.strictEqual(await rateBudget.acquire('shopify', 500), true);
    assert.strictEqual(await rateBudget.acquire('shopify', 50), false, 'second is paced');
  });

  test('stats expose what the budget is doing', async () => {
    rateBudget._reset();
    rateBudget.configure('shopify', 2.5, 5);
    await rateBudget.acquire('shopify', 100);
    const s = rateBudget.stats().find((x) => x.name === 'shopify');
    assert.strictEqual(s.ratePerSec, 2.5);
    assert.strictEqual(s.granted, 1);
  });

  test('a budget skip is classified as throttling, not as an error', () => {
    // It must skip the poll cleanly rather than count toward the circuit breaker: we declined
    // to send the request, the retailer did not refuse it.
    const { isRateLimited, isBudgetSkip } = require('../src/utils/stealth-http');
    const err = new Error('Rate limited (budget): https://shop.example/products.json');
    assert.ok(isRateLimited(err), 'must be treated as a throttle');
    assert.ok(isBudgetSkip(err), 'and be distinguishable from a real 429');
    assert.ok(!isBudgetSkip(new Error('Rate limited (429): https://shop.example/products.json')));
  });
});
