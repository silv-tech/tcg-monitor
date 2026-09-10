/**
 * poll-adapter must never write into an adapter's own catalogue.
 *
 * EB Games keeps its catalogue in memory and returns it directly:
 *
 *     return Object.fromEntries(this._knownProducts);      // ebgames.js
 *
 * so the objects poll-adapter receives ARE the adapter's objects. The out-of-stock
 * confirmation held a flickering product in stock by assigning `next.inStock = true`, which
 * therefore wrote the hold back into `_knownProducts`. The adapter then reported that held
 * value as its next observation, `prev.inStock && !next.inStock` was false, the streak reset,
 * and OOS_CONFIRM_POLLS could never be reached.
 *
 * Two consequences, both measured live on 2026-09-10:
 *   1. EB Games could never record a genuine sell-out — its only route to a stored
 *      inStock=false was the stale-cleanup path, which is absence, not stock.
 *   2. Every "restock" it emitted was therefore a SKU re-entering memory, not a product
 *      coming back: 436 RESTOCK alerts across 49 SKUs in 9h13m, each SKU firing 5-19 times,
 *      with repeats as close as 14 seconds apart.
 *
 * The existing oos-confirmation and poll-merge-scope suites MIRROR the logic in a local
 * function. A mirror has no adapter behind it, so it shares no references and cannot express
 * this bug — which is why it survived. These tests drive the real pollAdapterOnce.
 *
 * NOTE ON THE DECOY: poll-adapter short-circuits a poll whose stock-relevant digest is
 * unchanged, and a push-mode adapter reports an identical catalogue between pushes. So each
 * poll here bumps a second product's NAME — the one digest field that raises no event — which
 * is what the arrival of another category page actually does. Without it the second poll is
 * skipped entirely, which is correct production behaviour and would make these tests vacuous.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');

let redisProducts;   // what poll-adapter reads back as oldProducts
let stored;          // what poll-adapter last wrote

// Stubbed BEFORE poll-adapter is required: the real getRedis() constructs an ioredis client
// whose retry socket is a live handle, and `node --test` then never exits.
state.getRedis = () => ({ pipeline: () => ({ set() { return this; }, sadd() { return this; }, expire() { return this; }, sismember() { return this; }, exec: async () => [] }) });
state.getAllProducts = async () => redisProducts;
state.setLastCheck = async () => {};
state.clearErrors = async () => {};
state.setRetailerIndex = () => {};
state.getLastCheck = async () => Date.now();
state.getEarlyKeywords = async () => [];
// Only reached once an event actually fires, and they call state.js's OWN internal getRedis(),
// which the export stub above cannot intercept — so a RESTOCK opened a real connection and its
// socket kept the test runner alive with no output at all.
state.recordRestock = async () => {};
state.recordPrice = async () => {};

const { pollAdapterOnce } = require('../src/core/poll-adapter');

const product = (over = {}) => ({
  sku: 'A1', name: 'Pokemon TCG Prismatic Evolutions Elite Trainer Box',
  price: 59.99, inStock: true, canAddToCart: true, retailerId: 'ebgames',
  retailer: 'EB Games', ...over,
});

const decoy = (n) => ({
  sku: 'Z9', name: `Pokemon TCG Surging Sparks Booster Bundle ${n}`,
  price: 29.99, inStock: true, canAddToCart: true, retailerId: 'ebgames',
  retailer: 'EB Games',
});

/**
 * An adapter shaped exactly like EB Games in push mode: it owns a Map and hands out the very
 * objects inside it.
 */
function sharedCatalogueAdapter(initial) {
  const known = new Map(Object.entries(initial));
  return {
    id: 'ebgames',
    name: 'EB Games',
    _knownProducts: known,
    _bump: 0,
    // The line that makes the objects shared.
    async run() { return Object.fromEntries(this._knownProducts); },
    observe(sku, patch) { Object.assign(this._knownProducts.get(sku), patch); },
    held(sku) { return this._knownProducts.get(sku); },
  };
}

// Intercept the pipeline writes so we can read back exactly what would have been persisted.
async function poll(adapter, onEvents) {
  adapter.observe('Z9', { name: decoy(++adapter._bump).name });   // another page arrived
  const writes = {};
  state.getRedis = () => ({
    pipeline: () => {
      const p = {
        set: (key, json) => { const o = JSON.parse(json); writes[o.sku] = o; return p; },
        sadd: () => p, expire: () => p, sismember: () => p,
        exec: async () => [],
      };
      return p;
    },
  });
  const res = await pollAdapterOnce(adapter, {}, onEvents, 10000);
  // The decoy above is load-bearing: without a digest change poll-adapter short-circuits at the
  // top and every assertion in this file goes vacuous while staying green. Fail loudly instead.
  assert.notStrictEqual(res.unchanged, true,
    'poll was short-circuited by the content digest — the decoy has stopped working');
  stored = writes;
  return res;
}

function freshPair(over = {}) {
  return { A1: product(over), Z9: decoy(0) };
}

beforeEach(() => { stored = {}; });

describe('the confirmation hold must not reach back into the adapter', () => {
  test('a held product stays out of stock in the ADAPTER, even though Redis keeps it in stock', async () => {
    redisProducts = freshPair();
    const a = sharedCatalogueAdapter(freshPair());

    a.observe('A1', { inStock: false, canAddToCart: false });   // the browser reports it sold out
    await poll(a);

    // Redis keeps the last known good state — that is the hold working as designed.
    assert.strictEqual(stored.A1.inStock, true, 'one observation must not flip Redis');
    assert.strictEqual(stored.A1._oosStreak, 1, 'the flicker is remembered');

    // But the adapter's OWN copy must still say what the browser actually saw. If the hold
    // wrote through, the next observation would look identical to the held value and the
    // streak could never advance.
    assert.strictEqual(a.held('A1').inStock, false,
      'poll-adapter wrote its hold into the adapter catalogue — the streak can never complete');
  });

  test('a genuine sell-out IS recorded on the second consecutive observation', async () => {
    redisProducts = freshPair();
    const a = sharedCatalogueAdapter(freshPair());
    a.observe('A1', { inStock: false, canAddToCart: false });

    await poll(a);              // poll 1 — held
    redisProducts = stored;

    await poll(a);              // poll 2 — same observation, still out of stock
    assert.strictEqual(stored.A1.inStock, false,
      'two consecutive out-of-stock observations must be believed');
    assert.strictEqual(stored.A1._oosStreak, 2);
  });

  test('the sell-out then restock cycle produces exactly one RESTOCK, not a stream', async () => {
    redisProducts = freshPair();
    const a = sharedCatalogueAdapter(freshPair());
    const events = [];
    const collect = async (evs) => { for (const e of evs) events.push(e.type); };

    a.observe('A1', { inStock: false, canAddToCart: false });
    await poll(a, collect); redisProducts = stored;   // held
    await poll(a, collect); redisProducts = stored;   // confirmed out of stock
    assert.strictEqual(redisProducts.A1.inStock, false, 'precondition: it really did sell out');

    a.observe('A1', { inStock: true, canAddToCart: true });   // genuinely back
    await poll(a, collect); redisProducts = stored;
    await poll(a, collect); redisProducts = stored;           // and stays back
    await poll(a, collect);

    // deepStrictEqual on the WHOLE list, not a filtered count: a spurious NEW_SKU or
    // PRICE_CHANGE storm would be invisible to `restocks.length === 1`.
    assert.deepStrictEqual(events, ['RESTOCK'],
      `exactly one real restock and nothing else, got: ${events.join(',') || '(none)'}`);
  });

  test('a flicker still raises nothing at all', async () => {
    redisProducts = freshPair();
    const a = sharedCatalogueAdapter(freshPair());
    const events = [];
    const collect = async (evs) => { for (const e of evs) events.push(e.type); };

    a.observe('A1', { inStock: false, canAddToCart: false });   // bad render
    await poll(a, collect); redisProducts = stored;
    a.observe('A1', { inStock: true, canAddToCart: true });     // renders fine again
    await poll(a, collect);

    assert.deepStrictEqual(events, [], 'a one-poll flicker must be silent');
    assert.strictEqual(stored.A1.inStock, true);
  });
});

describe('Amazon reads its cache back, so the hold must not poison it', () => {
  /**
   * EB Games only WRITES its catalogue. Amazon also READS it to decide whether a stock reading
   * is trustworthy (amazon.js:1463):
   *
   *   raisesStockBlind = data.inStock && !cached?.inStock && !data.name
   *   inStock: raisesStockBlind ? cached.inStock : data.inStock
   *
   * A titleless AOD read claiming "in stock" is not allowed to raise a restock on its own. That
   * guard asks the cache whether the product was previously out of stock — so while the hold was
   * writing `inStock = true` into that cache, the guard's own precondition was being erased by
   * the poll that preceded it, and a stock-blind read could publish.
   */
  function amazonShapedAdapter(initial) {
    const known = new Map(Object.entries(initial));
    return {
      id: 'ebgames', name: 'EB Games', _knownProducts: known, _bump: 0,
      async run() { return Object.fromEntries(this._knownProducts); },
      observe(sku, patch) { Object.assign(this._knownProducts.get(sku), patch); },
      held(sku) { return this._knownProducts.get(sku); },
      // The read-back the guard depends on.
      readBlind(sku, data) {
        const cached = this._knownProducts.get(sku);
        const raisesStockBlind = data.inStock && !cached?.inStock && !data.name;
        return raisesStockBlind ? cached.inStock : data.inStock;
      },
    };
  }

  test('a stock-blind read still cannot publish after a hold has been written', async () => {
    redisProducts = freshPair();
    const a = amazonShapedAdapter(freshPair());

    a.observe('A1', { inStock: false, canAddToCart: false });   // AOD says sold out
    await poll(a);
    assert.strictEqual(stored.A1.inStock, true, 'held, as designed');

    // Now a titleless AOD read claims it is back. The guard must still see a cache that says
    // "was out of stock" — otherwise it cannot fire and the blind read is published.
    const verdict = a.readBlind('A1', { inStock: true, name: null });
    assert.strictEqual(verdict, false,
      'the hold leaked into the cache, erasing the precondition the blind-read guard needs');
  });

  test('a read WITH a title is still believed immediately', async () => {
    redisProducts = freshPair();
    const a = amazonShapedAdapter(freshPair());
    a.observe('A1', { inStock: false, canAddToCart: false });
    await poll(a);

    const verdict = a.readBlind('A1', { inStock: true, name: 'Pokemon TCG Booster Bundle' });
    assert.strictEqual(verdict, true, 'a titled restock must never be slowed by this guard');
  });
});

describe('the other in-place writes are copied too', () => {
  test('_missingStreak is not stamped onto the adapter catalogue', async () => {
    redisProducts = freshPair();
    const a = sharedCatalogueAdapter(freshPair());
    await poll(a);
    // Pin the positive first. Asserting only the absence would also pass if the confirmation
    // loop were deleted outright, or if the poll had returned early for any reason.
    assert.strictEqual(stored.A1._missingStreak, 0, 'the stored row does carry the bookkeeping');
    assert.strictEqual('_missingStreak' in a.held('A1'), false,
      'bookkeeping belongs to the stored row, not to the adapter');
  });

  test('a held steep price drop does not become the adapter next observation', async () => {
    redisProducts = freshPair({ price: 100 });
    const a = sharedCatalogueAdapter(freshPair({ price: 100 }));

    a.observe('A1', { price: 40 });    // -60%, past STEEP_DROP_PCT
    await poll(a);

    assert.strictEqual(stored.A1.price, 100, 'the drop is held for confirmation');
    assert.strictEqual(a.held('A1').price, 40,
      'the adapter must still hold what it actually observed');
  });
});
