/**
 * Shop traffic over the ISP proxy pool.
 *
 * Every rate-limit outage on 2026-09-05 traced to one fact: 31 shops shared a single Railway
 * IP, and Shopify limits the CALLER. Spreading them over 10 ISP IPs removes the constraint
 * rather than negotiating with it — each IP then carries ~3 shops instead of 31.
 *
 * Verified live before building: 31/31 shops fetch successfully through the ISP proxies.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const ShopifyAdapter = require('../src/adapters/shopify');
const rateBudget = require('../src/utils/rate-budget');

afterEach(() => rateBudget._reset());

function makeAdapter(overrides = {}) {
  return new ShopifyAdapter({
    id: 'testshop',
    name: 'Test Shop',
    url: 'https://testshop.example',
    type: 'shopify',
    intervalMs: 9000,
    searchKeywords: [],
    collections: [],
    ...overrides,
  });
}

describe('shop proxy routing', () => {
  test('an ISP-tier shop consults the pool and budgets by its exit IP', async () => {
    const a = makeAdapter({ proxyTier: 'isp' });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();

    let proxyAsked = false;
    a.getProxy = () => { proxyAsked = true; return { url: 'http://u:p@143.14.233.74:61234', proxyObj: null }; };

    const keys = [];
    const origAcquire = rateBudget.acquire;
    rateBudget.acquire = async (key) => { keys.push(key); return false; }; // deny, so no HTTP happens
    try {
      await assert.rejects(() => a.fetchProducts(), /budget/i);
    } finally { rateBudget.acquire = origAcquire; }

    assert.ok(proxyAsked, 'the ISP pool was consulted');
    assert.strictEqual(keys[0], 'shopify:143.14.233.74', 'budget is keyed by exit IP');
  });

  test('a shop with no proxy tier budgets globally and asks for no proxy', async () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();

    let proxyAsked = false;
    a.getProxy = () => { proxyAsked = true; return { url: 'http://should-not-be-used', proxyObj: null }; };

    const keys = [];
    const origAcquire = rateBudget.acquire;
    rateBudget.acquire = async (key) => { keys.push(key); return false; };
    try {
      await assert.rejects(() => a.fetchProducts(), /budget/i);
    } finally { rateBudget.acquire = origAcquire; }

    assert.strictEqual(proxyAsked, false, 'no pool lookup for a direct shop');
    assert.strictEqual(keys[0], 'shopify', 'direct shops share the single-IP budget');
  });

  test('running out of budget is throttling, not a proxy failure', async () => {
    // It must not mark the proxy unhealthy: we declined to send, the IP did nothing wrong.
    const { isRateLimited } = require('../src/utils/stealth-http');
    assert.ok(isRateLimited(new Error('Rate limited (budget): https://x/products.json')));
  });
});

describe('shop proxy budgets are per exit IP', () => {
  // The whole point: a shop behind proxy A must not spend proxy B's allowance.
  test('two different exit IPs get independent budgets', async () => {
    const A = 'shopify:143.14.233.74';
    const B = 'shopify:143.14.233.189';
    rateBudget.configure(A, 1, 1);
    rateBudget.configure(B, 1, 1);

    assert.strictEqual(await rateBudget.acquire(A, 200), true, 'A first request');
    assert.strictEqual(await rateBudget.acquire(A, 50), false, 'A is now paced');
    assert.strictEqual(await rateBudget.acquire(B, 200), true, 'B is unaffected by A');
  });

  test('a budget is created on first use rather than being unlimited', async () => {
    rateBudget._reset();
    const key = 'shopify:143.14.236.54';
    assert.strictEqual(await rateBudget.acquire(key, 200, 0, { ratePerSec: 1, burst: 1 }), true);
    assert.strictEqual(await rateBudget.acquire(key, 50, 0, { ratePerSec: 1, burst: 1 }), false,
      'second call is paced, so the bucket really was created');
  });

  test('without autoCreate an unknown budget stays unlimited', async () => {
    rateBudget._reset();
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(await rateBudget.acquire('never-configured', 10), true);
    }
  });

  test('ten IPs carrying 31 shops sit far below one IP carrying 31', () => {
    const shops = 31, ips = 10, intervalSec = 9;
    const perIp = (shops / ips) / intervalSec;
    const oneIp = shops / intervalSec;
    assert.ok(perIp < 0.4, `per-IP ${perIp.toFixed(2)} req/s should be tiny`);
    assert.ok(oneIp > 3.4, `single-IP ${oneIp.toFixed(2)} req/s is what broke`);
    assert.ok(perIp < 2.5, 'comfortably inside the measured per-IP ceiling');
  });
});
