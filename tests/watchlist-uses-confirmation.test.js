/**
 * The fast watchlist lane must run the SAME confirmation guards as the full poll.
 *
 * There are two poll pipelines. scheduler.js pollWatchlist reads priority products on their own
 * cadence and called diffProducts directly, writing state itself — so the lane with the fewest
 * brakes in the whole system was also the only lane with no confirmation at all:
 *
 *   - fetchProductPage stamps _watchlist, which EXEMPTS the row from the rate limiter
 *   - dedup drops from 600s to 45s
 *   - the delivery queue is bypassed
 *   - the alert fans out to extra channels
 *
 * A single flickering read there reaches the client's Discord faster, more often, and in more
 * places than anywhere else in the system. It is the last place that should believe one look.
 *
 * It was also silently resetting the bookkeeping: writing the raw read to state dropped
 * _oosStreak, _steepDropStreak and _missingStreak, so a streak the full poll had built up was
 * erased by the next fast poll — the two pipelines actively undid each other.
 *
 * Measured live 2026-09-11: Walmart on a 2s watchlist cadence, 96 reads in 14 minutes, and
 * Amazon's leg one unset env var (AMAZON_AOD_STEALTH) away from routing all 23 priority ASINs
 * through it.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');

// Stub the store BEFORE scheduler is required. scheduler.js does
// `const { recordRestock, recordPrice } = require('./state')`, which captures those function
// references at import time — patching them later leaves the real ones bound, they open an
// ioredis socket, and its retry loop hangs `node --test` forever with no failure message.
const stored = new Map();
state.getProduct = async (rid, sku) => stored.get(`${rid}:${sku}`) || null;
state.setProduct = async (rid, sku, p) => { stored.set(`${rid}:${sku}`, p); };
state.recordRestock = async () => {};
state.recordPrice = async () => {};

const { EVENT_TYPES } = require('../src/core/events');
const scheduler = require('../src/core/scheduler');   // exported as a singleton, not a class

const T0 = 1_757_600_000_000;

/** A fake adapter whose reads we script, standing in for fetchProductPage. */
function makeAdapter(reads) {
  let i = 0;
  return {
    id: 'amazon',
    name: 'Amazon Canada',
    intervalMs: 6000,
    watchlist: new Set(['B0TEST0001']),
    async fetchProductPage() {
      const r = reads[Math.min(i, reads.length - 1)];
      i++;
      return { ...r };
    },
  };
}

describe('pollWatchlist confirmation', () => {
  let delivered;

  beforeEach(() => {
    stored.clear();
    delivered = [];
  });

  const run = async (adapter) => {
    scheduler.register(adapter);
    scheduler.setEventHandler(async (events) => { delivered.push(...events); });
    try {
      await scheduler.pollWatchlist(adapter);
    } finally {
      // The module is a singleton, so leave nothing behind for the next test or suite.
      scheduler.adapters.delete(adapter.id);
      scheduler.circuits.delete(adapter.id);
      scheduler.polling.delete(`${adapter.id}:watchlist`);
      scheduler.onEvents = null;
    }
    return stored.get('amazon:B0TEST0001');
  };

  const row = (over = {}) => ({
    sku: 'B0TEST0001', name: 'Pokemon TCG Test Box', retailer: 'Amazon Canada',
    retailerId: 'amazon', inStock: true, price: 89.99, lastSeen: T0, _watchlist: true, ...over,
  });

  test('a single OOS read is HELD, not published', async () => {
    stored.set('amazon:B0TEST0001', row());
    const after = await run(makeAdapter([row({ inStock: false, lastSeen: T0 + 1000 })]));

    assert.strictEqual(after.inStock, true, 'one observation must not be believed here of all places');
    assert.strictEqual(after._oosStreak, 1, 'and the streak must be PERSISTED, not thrown away');
    assert.deepStrictEqual(delivered, [], 'nothing reaches the client channel yet');
  });

  test('the persisted streak lets a second genuine read confirm it', async () => {
    stored.set('amazon:B0TEST0001', row({ inStock: false, _oosStreak: 1, lastSeen: T0 + 1000 }));
    const after = await run(makeAdapter([row({ inStock: false, lastSeen: T0 + 240_000 })]));

    assert.strictEqual(after.inStock, false, 'two independent reads agree');
  });

  test('a REPLAY cannot confirm it, even at a 2s cadence', async () => {
    // The measured Walmart case: 96 reads in 14 minutes. If the underlying read is replayed, the
    // old code would have confirmed an out-of-stock flicker in 2 seconds.
    stored.set('amazon:B0TEST0001', row());
    const adapter = makeAdapter([row({ inStock: false, lastSeen: T0 + 1000 })]);

    let after;
    for (let i = 0; i < 20; i++) after = await run(adapter);   // same lastSeen every time

    assert.strictEqual(after._oosStreak, 1, '20 fast polls, one real read');
    assert.strictEqual(after.inStock, true, 'still held');
    assert.deepStrictEqual(delivered, [], 'and still silent');
  });

  test('a RESTOCK still fires on the first read — this lane must stay fast', async () => {
    stored.set('amazon:B0TEST0001', row({ inStock: false, _oosStreak: 2 }));
    const after = await run(makeAdapter([row({ inStock: true, lastSeen: T0 + 1000 })]));

    assert.strictEqual(after.inStock, true);
    assert.ok(delivered.some((e) => e.type === EVENT_TYPES.RESTOCK),
      'the whole point of the priority lane is speed on the way INTO stock');
  });

  test('a price CORRECTION is not published as a price drop', async () => {
    // The 2026-09-11 incident, but arriving through the fast lane instead of the full poll.
    stored.set('amazon:B0TEST0001', row({ price: 229, inStock: false }));
    const after = await run(makeAdapter([
      row({ price: 89.99, inStock: true, _pricePinned: true, lastSeen: T0 + 1000 }),
    ]));

    assert.strictEqual(after.price, 89.99, 'the authoritative price is stored');
    assert.ok(!delivered.some((e) => e.type === EVENT_TYPES.PRICE_CHANGE),
      'a correction of an unverified price is not a sale and must not alert');
    assert.ok(delivered.some((e) => e.type === EVENT_TYPES.RESTOCK),
      'but the real restock riding along still goes out');
  });

  test('a genuine steep drop is held on first sighting here too', async () => {
    stored.set('amazon:B0TEST0001', row({ price: 200, _pricePinned: true }));
    const after = await run(makeAdapter([
      row({ price: 80, _pricePinned: true, lastSeen: T0 + 1000 }),
    ]));

    assert.strictEqual(after.price, 200, 'held pending confirmation');
    assert.strictEqual(after._priceHeld, true);
    assert.ok(!delivered.some((e) => e.type === EVENT_TYPES.PRICE_CHANGE));
  });

  test('a brand-new watchlist product still fires NEW_SKU immediately', async () => {
    // No previous row means nothing to confirm against, and a first sighting must not be delayed.
    const after = await run(makeAdapter([row({ lastSeen: T0 + 1000 })]));

    assert.ok(after, 'stored');
    assert.ok(delivered.length > 0, 'a genuinely new priority product is news');
  });
});
