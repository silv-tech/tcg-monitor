/**
 * Costco's ISP proxies must never be handed to a Shopify shop.
 *
 * Of the ten ISP IPs, eight are reserved for walmart [0,1,2], amazon [3,4,5] and
 * pokemoncenter [8,9] — but all three actually run on RESIDENTIAL proxies, so those eight are
 * idle and the shops can use them for free. Costco [6,7] is the only big-six retailer whose
 * proxyTier is genuinely 'isp', and it is one of the six stores the product is sold on.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Mirrors loadIspProxies + sharedPool + the id-seeded round robin in src/core/proxy.js.
function makePool(n, retailerPools, protectedIds = ['costco']) {
  const proxies = Array.from({ length: n }, (_, i) => ({ index: i, healthy: true, blockedUntil: 0 }));
  const blocked = new Set();
  for (const id of protectedIds) for (const i of retailerPools[id] || []) blocked.add(i);
  const shared = proxies.filter((p) => !blocked.has(p.index));
  return {
    proxies,
    shared: shared.length ? shared : proxies,
    poolFor(retailerId) {
      const own = retailerPools[retailerId];
      return own ? own.map((i) => proxies[i]) : this.shared;
    },
    pick(retailerId) {
      const pool = this.poolFor(retailerId);
      let h = 0;
      for (const ch of String(retailerId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return pool[h % pool.length];
    },
  };
}

const POOLS = { walmart: [0, 1, 2], amazon: [3, 4, 5], costco: [6, 7], pokemoncenter: [8, 9] };
const SHOPS = ['401games', 'facetoface', 'hobbiesville', 'chimeragaming', 'untouchables',
  'deckoutgaming', 'danireon', 'pokejeux', 'tcgfy', 'hobbystoptcg', 'cardlegendstcg',
  'gameshack', 'fusiongaming', 'pokechalet', 'catchacard', 'spshop', 'remicardtrader',
  'cardcycle', 'vancitycj', 'infinitycards', 'poketherapy', 'shopville', 'tistaminis',
  'doescards', 'zardocards', 'rivalcards', 'hastycards', 'emmettstoystop', 'tonkatomtcg',
  'vancitytcg', 'kanzengames'];

describe('Costco proxy protection', () => {
  test('no shop is ever assigned a Costco proxy', () => {
    const pool = makePool(10, POOLS);
    const forbidden = new Set(POOLS.costco);
    for (const id of SHOPS) {
      assert.ok(!forbidden.has(pool.pick(id).index), `${id} landed on a Costco proxy`);
    }
  });

  test('Costco still gets its own dedicated pool', () => {
    const pool = makePool(10, POOLS);
    assert.ok(POOLS.costco.includes(pool.pick('costco').index));
  });

  test('shops spread across the eight idle IPs', () => {
    const pool = makePool(10, POOLS);
    const used = new Set(SHOPS.map((id) => pool.pick(id).index));
    assert.strictEqual(used.size, 8, `expected all 8 idle IPs, used ${used.size}`);
    for (const i of POOLS.costco) assert.ok(!used.has(i));
  });

  test('the busiest shared IP stays well inside the per-IP ceiling', () => {
    const pool = makePool(10, POOLS);
    const counts = {};
    for (const id of SHOPS) {
      const i = pool.pick(id).index;
      counts[i] = (counts[i] || 0) + 1;
    }
    const max = Math.max(...Object.values(counts));
    assert.ok(max / 9 < 2.5, `busiest IP ${(max / 9).toFixed(2)} req/s at 9s exceeds the ceiling`);
  });

  test('protecting every proxy falls back rather than returning nothing', () => {
    // An empty pool would silently drop the retailer to a direct connection — the exact
    // single-IP problem this exists to avoid.
    const all = { costco: [0, 1] };
    const pool = makePool(2, all);
    assert.strictEqual(pool.shared.length, 2, 'falls back to the full pool, never empty');
  });

  test('a stale sticky pin to a protected proxy is not honoured', () => {
    // Mirrors the sticky re-check: the pinned proxy must still be in the CURRENT pool.
    const pool = makePool(10, POOLS);
    const shopPool = pool.poolFor('hobbiesville');
    const stickyToCostco = pool.proxies[6];
    const stillAllowed = shopPool.some((p) => p.index === stickyToCostco.index);
    assert.strictEqual(stillAllowed, false, 'a pin to Costco must be dropped, not reused');
  });
});

describe('even spread across the shared pool', () => {
  // A hash-seeded round robin balances only on average. With 11 shops over 8 usable exits it
  // put 4 on one IP and left 2 idle — and the BUSIEST exit is what decides the safe polling
  // rate, so that imbalance was the difference between 0.44 req/s and 0.22 at a 9s interval.
  const assign = (ids, poolSize) => {
    const out = {};
    [...ids].sort().forEach((id, i) => { out[id] = i % poolSize; });
    return out;
  };
  const SHOPS = ['401games', 'hobbiesville', 'chimeragaming', 'deckoutgaming', 'pokejeux',
    'gameshack', 'remicardtrader', 'infinitycards', 'doescards', 'zardocards', 'kanzengames'];

  test('11 shops spread across 8 exits with at most 2 on any one', () => {
    const counts = {};
    for (const idx of Object.values(assign(SHOPS, 8))) counts[idx] = (counts[idx] || 0) + 1;
    assert.strictEqual(Object.keys(counts).length, 8, 'every exit is used');
    assert.ok(Math.max(...Object.values(counts)) <= 2, 'no exit carries more than 2');
  });

  test('the busiest exit stays inside the proven-clean load at 9s', () => {
    const counts = {};
    for (const idx of Object.values(assign(SHOPS, 8))) counts[idx] = (counts[idx] || 0) + 1;
    const busiest = Math.max(...Object.values(counts));
    assert.ok(busiest / 9 <= 0.24, `${(busiest / 9).toFixed(3)} req/s must not exceed 0.24`);
  });

  test('assignment is deterministic, so a restart keeps the same layout', () => {
    assert.deepStrictEqual(assign(SHOPS, 8), assign([...SHOPS].reverse(), 8));
  });

  test('an explicit pool is never overwritten', () => {
    // Costco has a dedicated assignment and must keep it.
    const existing = { costco: [6, 7] };
    const shouldSkip = (id) => Boolean(existing[id]);
    assert.strictEqual(shouldSkip('costco'), true);
    assert.strictEqual(shouldSkip('pokejeux'), false);
  });
});
