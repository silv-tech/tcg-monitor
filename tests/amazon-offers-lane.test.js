/**
 * Offers lane — the GUARANTEED per-ASIN stock check for search-invisible ASINs.
 *
 * Amazon serves no search tile for an item with no live offer, so an OOS-and-suppressed ASIN like
 * B0H78BB9TY (30th Celebration ETB) is never returned by the free batch sweep — it sits correctly
 * OOS and its restock has no tile to appear in. ScraperAPI's structured/offers returns a definitive
 * stock verdict tile-or-no-tile, so this lane fires the false->true RESTOCK the sweep cannot.
 *
 * These tests assert: the pinned-offer stock rule (incl. the marketplace-listing trap), the exact
 * B0H78BB9TY restock flip, the fail-safe (unreadable/budget-refusal -> carry forward, never OOS),
 * pacing + the hard daily cap, stalest-first targeting, and out-of-scope identity drop.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
// The out-of-scope drop now denylists via state.denyIdentity -> getRedis(); stub it so the test
// opens no ioredis handle (which would keep the process alive after the assertions pass).
const state = require('../src/core/state');
state.denyIdentity = async () => {};

function adapter() {
  const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000, proxyTier: 'none', watchlist: [] });
  a.reportFreshness = () => {};
  return a;
}
const OLD = Date.now() - 60 * 60 * 1000; // 1h ago — beyond OFFERS_STALE_MS (10min)


describe('pinned-offer stock rule', () => {
  test('buyable: pinned offer with a numeric price => in stock', () => {
    const d = adapter()._offersToData({ item: { name: 'ETB' }, listings: [{ price: 89.99, pinned_offer: true }] });
    assert.deepStrictEqual(d, { name: 'ETB', price: 89.99, inStock: true });
  });
  test('the marketplace trap: unpriced pinned + priced marketplace listings => OOS', () => {
    const d = adapter()._offersToData({ item: { name: 'ETB' }, listings: [{ price: undefined, pinned_offer: true }, { price: 128.98 }, { price: 119.89 }] });
    assert.strictEqual(d.inStock, false, 'no buy box => OOS regardless of other priced listings');
    assert.strictEqual(d.price, null);
  });
  test('unreadable payload (no item.name) => null (carry forward, never OOS)', () => {
    assert.strictEqual(adapter()._offersToData({ listings: [] }), null);
    assert.strictEqual(adapter()._offersToData(null), null);
    assert.strictEqual(adapter()._offersToData('garbage'), null);
  });
  test('fallback to listings[0] when nothing is flagged pinned', () => {
    const d = adapter()._offersToData({ item: { name: 'ETB' }, listings: [{ price: 42 }] });
    assert.strictEqual(d.inStock, true);
    assert.strictEqual(d.price, 42);
  });
});

describe('the exact missed restock now fires via the offers lane', () => {
  test('B0H78BB9TY inStock:false -> true when offers shows a priced pinned offer', async () => {
    const a = adapter();
    a._knownProducts.set('B0H78BB9TY', { sku: 'B0H78BB9TY', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 229, inStock: false, category: 'pokemon', lastSeen: OLD });
    a._fetchOffers = async (asin) => {
      assert.strictEqual(asin, 'B0H78BB9TY');
      return { item: { name: 'Pokémon TCG: 30th Celebration Elite Trainer Box' }, listings: [{ price: 89.99, pinned_offer: true, seller_name: 'Amazon.ca' }] };
    };
    const products = {};
    await a._runOffersLane(products);
    assert.strictEqual(products.B0H78BB9TY.inStock, true, 'the flip that fires RESTOCK');
    assert.strictEqual(products.B0H78BB9TY.price, 89.99, 'corrects the stale $229');
    assert.strictEqual(a._knownProducts.get('B0H78BB9TY').inStock, true);
  });

  test('a still-OOS offers read keeps it false (no false restock), updates lastSeen', async () => {
    const a = adapter();
    a._knownProducts.set('B0H78BB9TY', { sku: 'B0H78BB9TY', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 0, inStock: false, category: 'pokemon', lastSeen: OLD });
    a._fetchOffers = async () => ({ item: { name: 'Pokémon TCG: 30th Celebration Elite Trainer Box' }, listings: [{ price: undefined, pinned_offer: true }] });
    const products = {};
    await a._runOffersLane(products);
    assert.strictEqual(products.B0H78BB9TY.inStock, false, 'still OOS — no phantom restock');
    assert.ok(a._knownProducts.get('B0H78BB9TY').lastSeen > OLD, 'lastSeen refreshed (it is no longer "invisible")');
  });
});

describe('fail-safe: never manufacture OOS or overspend', () => {
  test('a budget refusal / error (fetch returns null) is a no-op — carry forward, no OOS, no spend', async () => {
    const a = adapter();
    a._knownProducts.set('B0X', { sku: 'B0X', inStock: true, price: 50, category: 'pokemon', lastSeen: OLD });
    a._fetchOffers = async () => null;
    const products = {};
    await a._runOffersLane(products);
    assert.strictEqual('B0X' in products, false, 'the cached (in-stock) row is untouched — carried forward, never flipped OOS');
    assert.strictEqual(a._offersToday, 0, 'a refused call spends no credit');
  });

  test('paced: only one paid call per interval', async () => {
    const a = adapter();
    a._knownProducts.set('B0A', { sku: 'B0A', inStock: false, category: 'pokemon', lastSeen: OLD });
    a._knownProducts.set('B0B', { sku: 'B0B', inStock: false, category: 'pokemon', lastSeen: OLD });
    let calls = 0;
    a._fetchOffers = async () => { calls++; return { item: { name: 'Pokemon TCG Box' }, listings: [{ price: undefined, pinned_offer: true }] }; };
    await a._runOffersLane({});
    await a._runOffersLane({}); // immediately again — should be rate-gated
    assert.strictEqual(calls, 1, 'the second call within the interval is gated (one paid call per interval)');
  });

  test('hard daily cap stops all paid calls', async () => {
    const a = adapter();
    a._knownProducts.set('B0A', { sku: 'B0A', inStock: false, category: 'pokemon', lastSeen: OLD });
    a._offersDay = new Date().toISOString().slice(0, 10);
    a._offersToday = 999999; // over any cap
    let calls = 0;
    a._fetchOffers = async () => { calls++; return {}; };
    await a._runOffersLane({});
    assert.strictEqual(calls, 0, 'over the daily cap => no paid call');
  });

  test('nothing stale => no paid call', async () => {
    const a = adapter();
    a._knownProducts.set('B0FRESH', { sku: 'B0FRESH', inStock: false, category: 'pokemon', lastSeen: Date.now() }); // fresh
    let calls = 0;
    a._fetchOffers = async () => { calls++; return {}; };
    await a._runOffersLane({});
    assert.strictEqual(calls, 0, 'the sweep already covers fresh ASINs — no paid call needed');
  });
});

describe('stalest-first targeting + identity', () => {
  test('checks the OLDEST-lastSeen invisible ASIN first (fair, no starvation)', async () => {
    const a = adapter();
    a._knownProducts.set('B0NEWER', { sku: 'B0NEWER', inStock: false, category: 'pokemon', lastSeen: Date.now() - 20 * 60 * 1000 });
    a._knownProducts.set('B0OLDEST', { sku: 'B0OLDEST', inStock: false, category: 'pokemon', lastSeen: Date.now() - 90 * 60 * 1000 });
    let checked = null;
    a._fetchOffers = async (asin) => { checked = asin; return { item: { name: 'Pokemon TCG Box' }, listings: [{ price: undefined, pinned_offer: true }] }; };
    await a._runOffersLane({});
    assert.strictEqual(checked, 'B0OLDEST', 'the stalest ASIN is checked first');
  });

  test('an out-of-scope live title drops the ASIN (identity drift)', async () => {
    const a = adapter();
    a._knownProducts.set('B0DRIFT', { sku: 'B0DRIFT', name: 'Pokémon TCG ETB', inStock: false, category: 'pokemon', lastSeen: OLD });
    a._fetchOffers = async () => ({ item: { name: 'PopSockets Phone Grip with Kickstand' }, listings: [{ price: 23.29, pinned_offer: true }] });
    const products = {};
    await a._runOffersLane(products);
    assert.strictEqual(a._knownProducts.has('B0DRIFT'), false, 'a drifted ASIN is dropped, not alerted under the old name');
    assert.strictEqual('B0DRIFT' in products, false);
  });
});
