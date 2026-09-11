/**
 * Priority watchlist — the "never miss the 30th Celebration restock, fast" wiring.
 *
 * Covers: the base.js cap-truncation watchlist exemption (the bug that deleted the B0H7* ASINs
 * before they could alert), seeding hand-picked ASINs into _knownProducts so the offers lanes
 * actually check them, the hydration exemption (a priority ASIN survives a redeploy even with an
 * out-of-scope stored name or a persisted denial), the single _watchlist stamp pass, and the
 * dedicated priority offers lane (round-robin, cadence + own daily cap, restock flip, and — unlike
 * the general lane — NEVER denylisting/dropping a priority ASIN or adopting an out-of-scope title).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const BaseAdapter = require('../src/adapters/base');
const state = require('../src/core/state');
// Keep the tests off the network / off Redis.
state.denyIdentity = async () => {};
state.getRedis = () => ({ get: async () => null, set: async () => {} });

const P1 = 'B0H784PD4X'; // 30th Celebration UPC (a real priority ASIN)
const P2 = 'B0H78BB9TY'; // 30th Celebration ETB

function adapter(extra = {}) {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000,
    proxyTier: 'none',
    watchlist: extra.watchlist || [P1, P2],
    priorityAsins: extra.priorityAsins || [P1, P2],
    timing: extra.timing || {},
  });
  a.reportFreshness = () => {};
  a._priorityOffersIntervalMs = extra.interval == null ? 0 : extra.interval; // 0 = never cadence-gate
  return a;
}

describe('base.js cap truncation exempts watchlist ASINs', () => {
  class TestAdapter extends BaseAdapter {
    constructor(cfg, products) { super(cfg); this.watchlist = new Set(cfg.watchlist || []); this._p = products; }
    async fetchProducts() { return { ...this._p }; }
  }

  test('a late-sorting watchlist ASIN survives truncation; the non-watchlist tail is still cut', async () => {
    // Sorted keys: A0,B0,C0,D0,E0,Z0WL1,Z0WL2. maxProducts=3. Watchlist = the two Z0* (sort last).
    const products = {
      A0: { sku: 'A0', name: 'a' }, B0: { sku: 'B0', name: 'b' }, C0: { sku: 'C0', name: 'c' },
      D0: { sku: 'D0', name: 'd' }, E0: { sku: 'E0', name: 'e' },
      Z0WL1: { sku: 'Z0WL1', name: 'wl1' }, Z0WL2: { sku: 'Z0WL2', name: 'wl2' },
    };
    const a = new TestAdapter({ id: 't', name: 'T', maxProducts: 3, watchlist: ['Z0WL1', 'Z0WL2'] }, products);
    const out = await a.run();
    assert.ok('Z0WL1' in out && 'Z0WL2' in out, 'both watchlist ASINs survive despite sorting into the deleted tail');
    assert.ok('A0' in out && 'B0' in out && 'C0' in out, 'the first maxProducts non-watchlist rows are kept');
    assert.ok(!('D0' in out) && !('E0' in out), 'the non-watchlist tail is still truncated');
    assert.strictEqual(Object.keys(out).length, 5, 'effective cap = maxProducts (3) + watchlist present (2)');
  });

  test('with no watchlist the cap behaves exactly as before', async () => {
    const products = { A0: { sku: 'A0', name: 'a' }, B0: { sku: 'B0', name: 'b' }, C0: { sku: 'C0', name: 'c' }, D0: { sku: 'D0', name: 'd' } };
    const a = new TestAdapter({ id: 't', name: 'T', maxProducts: 2, watchlist: [] }, products);
    const out = await a.run();
    assert.deepStrictEqual(Object.keys(out).sort(), ['A0', 'B0'], 'plain cap keeps the first maxProducts');
  });
});

describe('seeding watchlist ASINs into _knownProducts', () => {
  function stubHeavy(a) {
    a._hydrateFromRedis = async () => {};
    a._runDiscovery = async () => {};
    a._monitorKnownAsins = async () => {};
    a._purgeOutOfScopeState = async () => {};
    a._findGuessedRows = async () => {};
  }

  test('every watchlist ASIN not already known is seeded OOS with the flag', async () => {
    const a = adapter();
    stubHeavy(a);
    await a._collectProducts();
    for (const asin of [P1, P2]) {
      assert.ok(a._knownProducts.has(asin), `${asin} seeded into _knownProducts`);
      const row = a._knownProducts.get(asin);
      assert.strictEqual(row.inStock, false, 'seeded OOS so the first in-stock read fires a clean RESTOCK');
      assert.strictEqual(row._watchlist, true);
      assert.strictEqual(row.isTCG, true, 'isTCG forced true despite the placeholder name — else deliver() would silently drop the restock');
      assert.strictEqual(row.retailerId, 'amazon', 'classify() ran (retailerId stamped)');
    }
  });

  test('a real hydrated row is never clobbered by the placeholder', async () => {
    const a = adapter();
    stubHeavy(a);
    a._knownProducts.set(P1, { sku: P1, name: 'Pokémon TCG: 30th Celebration Ultra-Premium Collection', inStock: true, price: 199, category: 'pokemon', lastSeen: Date.now() });
    await a._collectProducts();
    assert.strictEqual(a._knownProducts.get(P1).name, 'Pokémon TCG: 30th Celebration Ultra-Premium Collection', 'real name preserved');
    assert.strictEqual(a._knownProducts.get(P1).inStock, true, 'real state preserved');
  });

  test('a persisted denial never blocks a priority ASIN from being tracked', async () => {
    const a = adapter();
    stubHeavy(a);
    a._denied.add(P1);
    await a._collectProducts();
    assert.ok(a._knownProducts.has(P1), 'seeded despite being on the denylist');
    assert.ok(!a._denied.has(P1), 'and cleared from the denied set');
  });
});

describe('hydration exemption', () => {
  test('a watchlist ASIN hydrates even with an out-of-scope stored name or a denial; a non-watchlist one does not', async () => {
    const a = adapter({ watchlist: ['B0WLSCOPE', 'B0WLDENIED'], priorityAsins: [] });
    state.getAllProducts = async () => ({
      B0WLSCOPE: { name: 'Generic Storage Box Accessory' },        // watchlist, out of scope
      B0WLDENIED: { name: 'Pokémon TCG: 30th Celebration ETB' },   // watchlist, but denied
      B0JUNK: { name: 'Random Non-Pokemon Merch' },                // not watchlist, out of scope
    });
    state.getDeniedIdentities = async () => new Map([['B0WLDENIED', 'x']]);
    await a._hydrateFromRedis();
    assert.ok(a._knownProducts.has('B0WLSCOPE'), 'out-of-scope watchlist ASIN still hydrates');
    assert.ok(a._knownProducts.has('B0WLDENIED'), 'denied watchlist ASIN still hydrates');
    assert.ok(!a._knownProducts.has('B0JUNK'), 'a non-watchlist out-of-scope ASIN is still skipped');
  });
});

describe('the _watchlist stamp pass at the end of _collectProducts', () => {
  test('stamps _watchlist AND forces isTCG on watchlist products, and only those', async () => {
    const a = adapter();
    a._hydrateFromRedis = async () => {};
    a._monitorKnownAsins = async () => {};
    a._purgeOutOfScopeState = async () => {};
    a._findGuessedRows = async () => {};
    a._runDiscovery = async (products) => {
      // A watchlist row still carrying the placeholder name — classifies isTCG:false. The stamp
      // pass must force it true, or deliver()'s first filter drops the restock silently.
      products[P1] = { sku: P1, name: `Amazon ASIN ${P1}`, inStock: true, price: 199, isTCG: false };
      products.B0NOTWL = { sku: 'B0NOTWL', name: 'Some other pokemon thing', inStock: true, price: 50, isTCG: false };
    };
    const out = await a._collectProducts();
    assert.strictEqual(out[P1]._watchlist, true, 'watchlist product stamped');
    assert.strictEqual(out[P1].isTCG, true, 'isTCG forced true so deliver() cannot silently drop it');
    assert.ok(!out.B0NOTWL._watchlist, 'non-watchlist product not stamped');
    assert.strictEqual(out.B0NOTWL.isTCG, false, 'non-watchlist product left as-is');
  });
});

describe('priority offers lane', () => {
  const OOS = { item: { name: 'Pokémon TCG: 30th Celebration' }, listings: [{ price: undefined, pinned_offer: true }] };

  test('round-robins one ASIN per call, cycling the whole list', async () => {
    const a = adapter({ priorityAsins: [P1, P2] });
    a._knownProducts.set(P1, { sku: P1, name: 'ETB', inStock: false, category: 'pokemon' });
    a._knownProducts.set(P2, { sku: P2, name: 'UPC', inStock: false, category: 'pokemon' });
    const checked = [];
    a._fetchOffers = async (asin) => { checked.push(asin); return OOS; };
    await a._runPriorityOffersLane({});
    await a._runPriorityOffersLane({});
    await a._runPriorityOffersLane({});
    assert.deepStrictEqual(checked, [P1, P2, P1], 'cursor advances and wraps');
  });

  test('cadence-gated: only one call per interval', async () => {
    const a = adapter({ interval: 60000 });
    a._knownProducts.set(P1, { sku: P1, inStock: false, category: 'pokemon' });
    let calls = 0;
    a._fetchOffers = async () => { calls++; return OOS; };
    await a._runPriorityOffersLane({});
    await a._runPriorityOffersLane({}); // immediately again — gated
    assert.strictEqual(calls, 1);
  });

  test('own daily cap stops paid calls (separate from the general lane cap)', async () => {
    const a = adapter();
    a._knownProducts.set(P1, { sku: P1, inStock: false, category: 'pokemon' });
    a._priorityOffersDay = new Date().toISOString().slice(0, 10);
    a._priorityOffersToday = 999999;
    let calls = 0;
    a._fetchOffers = async () => { calls++; return OOS; };
    await a._runPriorityOffersLane({});
    assert.strictEqual(calls, 0);
  });

  test('a null fetch (budget refusal / error) is a no-op — no spend, no OOS', async () => {
    const a = adapter({ priorityAsins: [P1] });
    a._knownProducts.set(P1, { sku: P1, inStock: true, price: 50, category: 'pokemon' });
    a._fetchOffers = async () => null;
    const products = {};
    await a._runPriorityOffersLane(products);
    assert.strictEqual(P1 in products, false, 'carried forward, never flipped OOS');
    assert.strictEqual(a._priorityOffersToday, 0, 'no credit spent');
  });

  test('the restock flip fires and carries the _watchlist flag', async () => {
    const a = adapter({ priorityAsins: [P1] });
    a._knownProducts.set(P1, { sku: P1, name: 'Pokémon TCG: 30th Celebration UPC', price: 0, inStock: false, category: 'pokemon' });
    a._fetchOffers = async () => ({ item: { name: 'Pokémon TCG: 30th Celebration UPC' }, listings: [{ price: 199.99, pinned_offer: true, seller_name: 'Amazon.ca' }] });
    const products = {};
    await a._runPriorityOffersLane(products);
    assert.strictEqual(products[P1].inStock, true, 'false→true RESTOCK');
    assert.strictEqual(products[P1].price, 199.99);
    assert.strictEqual(products[P1]._watchlist, true);
  });

  test('an out-of-scope live title is KEPT (not denylisted/dropped) and the stored name is preserved for the delivery gate', async () => {
    const a = adapter({ priorityAsins: [P1] });
    a._knownProducts.set(P1, { sku: P1, name: 'Pokémon TCG: 30th Celebration UPC', inStock: false, category: 'pokemon' });
    a._fetchOffers = async () => ({ item: { name: 'PopSockets Phone Grip with Kickstand' }, listings: [{ price: 23.29, pinned_offer: true }] });
    const products = {};
    await a._runPriorityOffersLane(products);
    assert.ok(a._knownProducts.has(P1), 'a priority ASIN is NEVER dropped on a scope miss');
    assert.strictEqual(products[P1].inStock, true, 'its stock is still updated');
    assert.strictEqual(products[P1].name, 'Pokémon TCG: 30th Celebration UPC', 'stored name preserved so the delivery gate can still detect divergence');
    assert.strictEqual(products[P1]._watchlist, true);
  });
});
