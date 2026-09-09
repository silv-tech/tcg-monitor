/**
 * At a pickup-only retailer, shelf stock decides availability — not the website.
 *
 * `isAvailable` in London Drugs' product API is an ONLINE flag, and London Drugs does not ship
 * TCG: every tracked item is InStorePickupOnly. So a product can read isAvailable:false while
 * sitting on shelves and being perfectly buyable today.
 *
 * Measured live on 2026-09-09 across all 78 stores, 8 of 25 tracked products were in exactly that
 * state and we reported every one of them as out of stock, firing no alert:
 *
 *   L3408421  Pitch Black Elite Trainer Box   isAvailable:false   41 units / 2 stores
 *   L3408379  Mega Greninja ex Premium Coll   isAvailable:false   33 units / 4 stores
 *   L3202782  Phantasmal Flames Booster Pack  isAvailable:false   23 units / 1 store
 *   L3058473  SV10 Destined Rivals            isAvailable:false   22 units / 2 stores
 *
 * The store data was already fetched and attached — it simply never reached a truth value.
 *
 * Also pinned: the quantity shown. `stockCount` is onlineStockLevel, which understated shelf
 * reality by 2x to 58x — "Stock: 2" against 117 units across 12 stores.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const scraperApi = require('../src/utils/scraper-api');
const state = require('../src/core/state');
const storeAvail = require('../src/utils/ld-store-availability');
const LondonDrugsAdapter = require('../src/adapters/londondrugs');

state.getRedis = () => null;

const CFG = {
  id: 'londondrugs', name: 'London Drugs', url: 'https://www.londondrugs.com',
  adapter: 'londondrugs', intervalMs: 30000, proxyTier: 'residential', enabled: true, timing: {},
};

const store = (code, qty) => ({
  code, name: `Store ${code}`, distanceM: null, stockAvailable: qty,
  address1: '1 Main St', city: 'Vancouver', province: 'British Columbia', postal: 'V6B 1A1', phone: '',
});

/** Drive fetchProducts with a fixed catalogue and a fixed store cache. */
function adapterWith(products, storeRows) {
  const a = new LondonDrugsAdapter(CFG);
  a._maybeEnrichStores = () => {};
  a._sweep = async () => {};
  a._lastSweepAt = Date.now();
  a._fetchCategory = async () => '<html>stub</html>';
  a._toProducts = () => products.map((p) => ({ ...p }));
  a._loadStores = async () => {};
  a._stores = new Map(Object.entries(storeRows || {}));
  return a;
}

const listed = (sku, over = {}) => ({
  sku, name: `Pokemon TCG: ${sku}`, price: 49.99, currency: 'CAD',
  url: `https://www.londondrugs.com/products/p/${sku}`,
  inStock: false, canAddToCart: false, shipsToHome: false, pickupOnly: true,
  stockCount: null, seller: 'London Drugs', isTCG: true, ...over,
});

beforeEach(() => { scraperApi.isConfigured = () => false; });

describe('a product on shelves is available, whatever the website says', () => {
  test('the Pitch Black ETB case: online says no, 41 units in 2 stores says yes', async () => {
    const a = adapterWith([listed('L3408421')], { L3408421: [store('021', 21), store('030', 20)] });
    const out = await a.fetchProducts();
    const p = out.L3408421 || Object.values(out)[0];
    assert.strictEqual(p.inStock, true, 'a buyer can walk in and buy this today');
    assert.strictEqual(p._stockQty, 41, 'the quantity shown must be the one a buyer can act on');
  });

  test('the alert quantity is shelf stock, not the online number', async () => {
    // L3408395 measured: onlineStockLevel 2, shelves 117 across 12 stores.
    const rows = Array.from({ length: 12 }, (_, i) => store(String(i).padStart(3, '0'), i === 0 ? 7 : 10));
    const a = adapterWith([listed('L3408395', { inStock: true, canAddToCart: true, stockCount: 2 })], { L3408395: rows });
    const out = await a.fetchProducts();
    const p = Object.values(out)[0];
    assert.strictEqual(p._stockQty, 117);
    assert.notStrictEqual(p._stockQty, p.stockCount, '"Stock: 2" against 117 on shelves is the bug');
  });

  test('no shelf stock and no online stock stays out of stock', async () => {
    const a = adapterWith([listed('L3272363')], { L3272363: [store('021', 0)] });
    const p = Object.values(await a.fetchProducts())[0];
    assert.strictEqual(p.inStock, false, 'sold out everywhere is a real state');
    assert.strictEqual(p._stockQty, undefined, 'no invented quantity');
  });

  test('a product with no store data at all is left exactly as the site described it', async () => {
    const a = adapterWith([listed('L3310114')], {});
    const p = Object.values(await a.fetchProducts())[0];
    assert.strictEqual(p.inStock, false, 'absent enrichment must not manufacture availability');
    assert.strictEqual(p._stores, undefined);
  });

  test('online availability is never downgraded by missing store data', async () => {
    const a = adapterWith([listed('L3336291', { inStock: true, canAddToCart: true, stockCount: 20 })], {});
    const p = Object.values(await a.fetchProducts())[0];
    assert.strictEqual(p.inStock, true, 'a failed store lookup must not read as sold out');
  });

  test('canAddToCart still reflects ONLINE purchase, not shelf stock', async () => {
    const a = adapterWith([listed('L3408421')], { L3408421: [store('021', 41)] });
    const p = Object.values(await a.fetchProducts())[0];
    assert.strictEqual(p.inStock, true);
    assert.strictEqual(p.canAddToCart, false,
      'there is no online cart for this — saying otherwise would send a buyer to a dead button');
  });
});

describe('the store count in the embed is the real one', () => {
  test('the row cap is the number of stores that exist, so nothing is truncated before counting', () => {
    assert.strictEqual(storeAvail.ALL_LOCATION_CODES.length, 78);
  });

  test('a product in stock at 69 stores does not advertise "+39"', async () => {
    // Measured: L3408387 was in stock at 69 stores; the embed said "+39 other stores".
    const rows = Array.from({ length: 69 }, (_, i) => store(String(i).padStart(3, '0'), 100 + i));
    const a = adapterWith([listed('L3408387', { inStock: true, stockCount: 1811 })], { L3408387: rows });
    const p = Object.values(await a.fetchProducts())[0];
    assert.strictEqual(p._stores.length, 69, 'truncating before the count is what produced the wrong number');
    const field = storeAvail.formatStoreField(p._stores);
    assert.match(field, /\+68 other stores in stock/);
  });
});
