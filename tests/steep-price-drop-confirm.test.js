/**
 * A steep price drop is believed only when a second poll agrees.
 *
 * A client's channel received these as buying opportunities. None was a discount — each row's
 * cached price had come from the wrong variant of a multi-variant product:
 *
 *   Fusion Strike Sleeved Pack    $5745 -> $52     (-99%)
 *   Silver Tempest Sleeved Pack   $2650 -> $25     (-99%)
 *   Paldea Evolved Sleeved Pack   $2900 -> $25     (-99%)
 *   Brilliant Stars Sleeved Pack   $550 -> $30     (-95%)
 *   Display of 10 Lost Origin     $7200 -> $1650   (-77%)
 *
 * events.js now refuses anything past 90% outright, as impossible. That deliberately left the
 * -77% case through: at that depth a genuine blowout sale is possible, and a threshold cannot
 * separate the two from a SINGLE observation.
 *
 * Two observations can. A one-poll artifact does not survive the next read; a real price cut does.
 * So a drop of at least STEEP_DROP_PCT is held on first sighting — the old price is kept, which
 * raises no event at all — and released when the next poll agrees.
 *
 * This mirrors OOS_CONFIRM_POLLS deliberately, including its asymmetry: only DROPS are held, and
 * only steep ones. A price cut is not a race the way a restock is, so one extra poll costs nothing;
 * a restock is still never delayed. Do not "simplify" this into a symmetric debounce.
 *
 * These tests drive the REAL pollAdapterOnce rather than a copy of its logic. The sibling
 * oos-confirmation.test.js reimplements the step it checks, and a mirrored copy can silently drift
 * from the code it claims to protect.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
const { pollAdapterOnce } = require('../src/core/poll-adapter');

// Redis stays out of this entirely; the confirmation step is pure in-memory bookkeeping.
const real = {};
let stored = {};

beforeEach(() => {
  stored = {};
  // Every state function poll-adapter touches. Missing even one lets the real implementation run,
  // which opens a Redis socket and holds the test process open after the assertions finish.
  for (const k of ['getAllProducts', 'saveProducts', 'saveProduct', 'setLastCheck', 'getLastCheck',
    'setRetailerIndex', 'deleteProduct', 'recordRestock', 'recordPrice', 'getRedis',
    'clearErrors', 'getEarlyKeywords']) {
    if (typeof state[k] === 'function') real[k] = state[k];
  }
  state.getAllProducts = async () => JSON.parse(JSON.stringify(stored));
  state.saveProducts = async () => {};
  state.saveProduct = async () => {};
  state.setLastCheck = async () => {};
  state.getLastCheck = async () => Date.now() - 60000;
  state.setRetailerIndex = async () => {};
  state.deleteProduct = async () => {};
  state.recordRestock = async () => {};
  state.recordPrice = async () => {};
  state.clearErrors = async () => {};
  state.getEarlyKeywords = async () => [];
  // poll-adapter persists through a real Redis pipeline (poll-adapter.js:291), so a null client
  // throws before the assertions are reached. This fake captures the writes into `stored`, which
  // makes the persisted row — the thing the next poll reads as `prev` — directly assertable.
  state.getRedis = () => ({
    pipeline() {
      const ops = [];
      return {
        set(key, val) { ops.push([key, val]); return this; },
        async exec() {
          for (const [key, val] of ops) {
            const sku = String(key).split(':').pop();
            stored[sku] = JSON.parse(val);
          }
          return [];
        },
      };
    },
    async sadd() {}, async smembers() { return []; }, async get() { return null; },
    async set() {}, async del() {}, async expire() {}, async hset() {}, async hgetall() { return {}; },
  });
});

afterEach(() => { for (const [k, fn] of Object.entries(real)) state[k] = fn; });

const row = (price, over = {}) => ({
  sku: 'S1', name: 'Pokemon TCG Sleeved Pack', retailerId: 'testshop', retailer: 'Test Shop',
  price, inStock: true, canAddToCart: true, isTCG: true, category: 'pokemon',
  url: 'https://x/p/s1', ...over,
});

/** Runs one poll returning `price`, collecting any events raised. */
async function poll(price) {
  const events = [];
  const adapter = {
    id: 'testshop', name: 'Test Shop', enabled: true,
    run: async () => ({ S1: row(price) }),
    reportFreshness() {}, _lastFreshness: null,
  };
  await pollAdapterOnce(adapter, { isOpen: () => false, recordSuccess() {}, recordFailure() {} },
    async (evs) => { events.push(...evs); }, 20000);
  return events;
}

const priceEvents = (evs) => evs.filter((e) => e.type === 'PRICE_CHANGE');

describe('a steep drop is held until a second poll agrees', () => {
  test('the first sighting raises no price event', async () => {
    await poll(7200);                       // seed
    const evs = await poll(1650);           // -77%
    assert.deepStrictEqual(priceEvents(evs), [],
      'one observation cannot distinguish a blowout sale from a bad row');
    assert.strictEqual(stored.S1.price, 7200, 'the old price is kept, so nothing downstream sees a change');
    assert.strictEqual(stored.S1._steepDropStreak, 1, 'but the sighting is remembered');
  });

  test('the second consecutive sighting releases it', async () => {
    await poll(7200);
    await poll(1650);
    const evs = await poll(1650);
    assert.strictEqual(priceEvents(evs).length, 1, 'a real cut persists and must still alert');
    assert.strictEqual(priceEvents(evs)[0].newValue, 1650);
    assert.strictEqual(stored.S1.price, 1650);
  });

  test('a one-poll artifact that snaps back never alerts at all', async () => {
    await poll(7200);
    const a = await poll(1650);   // the artifact
    const b = await poll(7200);   // reality returns
    assert.deepStrictEqual(priceEvents(a), []);
    assert.deepStrictEqual(priceEvents(b), [], 'and the recovery must not read as a change either');
    assert.strictEqual(stored.S1.price, 7200);
  });

  test('all five real incidents are held on first sighting', async () => {
    for (const [from, to] of [[5745, 52], [2650, 25], [2900, 25], [550, 30], [7200, 1650]]) {
      stored = {};
      await poll(from);
      assert.deepStrictEqual(priceEvents(await poll(to)), [], `${from} -> ${to} should be held`);
    }
  });
});

describe('ordinary drops are never delayed', () => {
  for (const [from, to, pct] of [[100, 65, 35], [200, 105, 47], [59.99, 49.99, 17], [675, 565, 16]]) {
    test(`a ${pct}% drop ($${from} -> $${to}) alerts on the FIRST poll`, async () => {
      await poll(from);
      assert.strictEqual(priceEvents(await poll(to)).length, 1,
        'the confirmation must only touch steep drops, or every real sale is slowed');
    });
  }

  test('a drop just under the steep threshold is immediate', async () => {
    await poll(100);
    assert.strictEqual(priceEvents(await poll(50.5)).length, 1, '-49.5% is ordinary');
  });

  test('a drop at the threshold is held', async () => {
    await poll(100);
    assert.deepStrictEqual(priceEvents(await poll(50)), [], '-50% needs confirming');
  });
});

describe('the streak resets so a held drop cannot leak later', () => {
  test('a price rise clears the streak', async () => {
    await poll(7200);
    await poll(1650);                                   // held, streak 1
    assert.strictEqual(stored.S1._steepDropStreak, 1);
    await poll(7200);                                   // back up
    assert.strictEqual(stored.S1._steepDropStreak || 0, 0, 'a recovered price is not a pending drop');
  });

  test('an unchanged price clears the streak', async () => {
    await poll(100);
    await poll(100);
    assert.strictEqual(stored.S1._steepDropStreak || 0, 0);
  });

  test('a restock is never delayed by any of this', async () => {
    await poll(100);
    stored.S1.inStock = false;
    stored.S1.canAddToCart = false;
    const evs = await poll(100);
    assert.strictEqual(evs.filter((e) => e.type === 'RESTOCK').length, 1,
      'going INTO stock still fires on the first observation — that asymmetry is the point');
  });
});
