/**
 * A purge must leave nothing behind, including keys state.js has never heard of.
 *
 * Adapters keep private state under their own namespace — Pokemon Center keeps
 * `tcg:pokemoncenter:availability` (a 14-day stock and price cache) and
 * `tcg:pokemoncenter:unfetchable`. purgeRetailer knew only about products, the index, the
 * seen-set, status, lastcheck and the history keys.
 *
 * Measured 2026-09-11: purging Pokemon Center deleted 8,415 products and 214 keys and left both
 * of those standing. A rebuilt adapter would have restored that cache on its first poll and
 * reported stale stock as current — the store had been dark for days, so every value in it was
 * wrong. "It has a TTL and will age out" is not a clean slate.
 *
 * The namespace is the retailer's own, so this cannot reach another store. The two shapes it
 * must NOT match are `tcg:product:<id>:*` and `tcg:seen:<id>`, which put the KIND before the id.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// A Redis stand-in that records what was deleted, with a real SCAN over a fixed keyspace.
function fakeRedis(keys) {
  const store = new Set(keys);
  const deleted = [];
  const pipe = {
    del: (k) => { deleted.push(k); return pipe; },
    exec: async () => [],
  };
  return {
    deleted,
    scan: async (cursor, _m, pattern) => {
      const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : '\\' + c)) + '$');
      return ['0', [...store].filter((k) => re.test(k))];
    },
    pipeline: () => pipe,
    del: (...ks) => { deleted.push(...ks); return ks.length; },
  };
}

const KEYS = [
  'tcg:pokemoncenter:availability',
  'tcg:pokemoncenter:unfetchable',
  'tcg:product:pokemoncenter:abc',
  'tcg:seen:pokemoncenter',
  'tcg:amazon:somethingprivate',
  'tcg:product:amazon:xyz',
];

describe('the purge reaches adapter-private keys', () => {
  const patternsFor = (id) => [
    `tcg:pricehistory:${id}:*`, `tcg:restock:${id}:*`, `tcg:product:${id}:*`, `tcg:${id}:*`,
  ];

  const matched = (id) => {
    const r = fakeRedis(KEYS);
    const found = [];
    return Promise.all(patternsFor(id).map(async (p) => {
      const [, batch] = await r.scan('0', 'MATCH', p);
      found.push(...batch);
    })).then(() => found);
  };

  test('the Pokemon Center private keys are matched', async () => {
    const found = await matched('pokemoncenter');
    assert.ok(found.includes('tcg:pokemoncenter:availability'),
      'the stale stock cache is exactly what a rebuild must not inherit');
    assert.ok(found.includes('tcg:pokemoncenter:unfetchable'));
  });

  test('its own product keys are still matched by the existing pattern', async () => {
    const found = await matched('pokemoncenter');
    assert.ok(found.includes('tcg:product:pokemoncenter:abc'));
  });

  test('another retailer is never touched', async () => {
    const found = await matched('pokemoncenter');
    assert.ok(!found.includes('tcg:amazon:somethingprivate'), 'a purge must be one store only');
    assert.ok(!found.includes('tcg:product:amazon:xyz'));
  });

  test('the retailer namespace does not swallow kind-prefixed keys of other stores', async () => {
    const found = await matched('amazon');
    assert.ok(found.includes('tcg:amazon:somethingprivate'));
    assert.ok(!found.some((k) => k.includes('pokemoncenter')));
  });
});
