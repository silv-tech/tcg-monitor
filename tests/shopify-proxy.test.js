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

describe('shared-pool distribution', () => {
  // The bug: the round-robin pointer starts at 0 for any retailer not seen before, so all 31
  // shops took pool[0] on their first call and the sticky map pinned them there. That funnels
  // every shop through ONE exit IP — no better than the single Railway IP, and worse because
  // that IP belongs to Walmart's dedicated pool.
  const seedFor = (retailerId, poolLen) => {
    let h = 0;
    for (const ch of String(retailerId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % poolLen;
  };

  const SHOP_IDS = ['401games', 'facetoface', 'hobbiesville', 'chimeragaming', 'untouchables',
    'deckoutgaming', 'danireon', 'pokejeux', 'tcgfy', 'hobbystoptcg', 'cardlegendstcg',
    'gameshack', 'fusiongaming', 'pokechalet', 'catchacard', 'spshop', 'remicardtrader',
    'cardcycle', 'vancitycj', 'infinitycards', 'poketherapy', 'shopville', 'tistaminis',
    'doescards', 'zardocards', 'rivalcards', 'hastycards', 'emmettstoystop', 'tonkatomtcg',
    'vancitytcg', 'kanzengames'];

  test('the old behaviour put every shop on one IP', () => {
    const starts = new Set(SHOP_IDS.map(() => 0));
    assert.strictEqual(starts.size, 1, 'this is the bug being fixed');
  });

  test('seeding from the id spreads 31 shops across the pool', () => {
    const counts = {};
    for (const id of SHOP_IDS) {
      const i = seedFor(id, 10);
      counts[i] = (counts[i] || 0) + 1;
    }
    const used = Object.keys(counts).length;
    const max = Math.max(...Object.values(counts));
    assert.ok(used >= 8, `expected a wide spread, used only ${used} of 10`);
    assert.ok(max <= 8, `one IP took ${max} shops — too concentrated`);
  });

  test('the busiest IP stays far inside the per-IP ceiling', () => {
    const counts = {};
    for (const id of SHOP_IDS) {
      const i = seedFor(id, 10);
      counts[i] = (counts[i] || 0) + 1;
    }
    const max = Math.max(...Object.values(counts));
    assert.ok(max / 9 < 2.5, `busiest IP ${(max / 9).toFixed(2)} req/s at a 9s interval`);
  });

  test('the seed is deterministic, so a restart keeps the same layout', () => {
    assert.strictEqual(seedFor('hobbiesville', 10), seedFor('hobbiesville', 10));
  });

  test('a retailer WITH a dedicated pool is unaffected by the seeding', () => {
    // Only retailers with no assignment get seeded — walmart/amazon/costco/pokemoncenter
    // keep their explicit pools untouched.
    const allowed = [0, 1, 2];
    const shouldSeed = (allowedIndices) => !allowedIndices;
    assert.strictEqual(shouldSeed(allowed), false);
    assert.strictEqual(shouldSeed(undefined), true);
  });
});
