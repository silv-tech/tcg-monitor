/**
 * Keyword search for the Shopify shops — the approach the big seven already used.
 *
 * Walmart, Amazon, Best Buy and Costco send the shared query list from config/products.json to
 * each retailer's own search engine. The shops were the odd ones out, walking up to a hundred
 * catalogue pages to reach the same products, which is what pushed detection latency for a
 * product on page 5 from 15 minutes to 2.5 hours.
 *
 * Measured live: 18 queries find 118 in-scope products at hobbiesville where pagination needs
 * 56 page requests for ~130.
 *
 * The dangerous part is identity. Shopify predictive search omits variant.sku while
 * products.json supplies it, and most shops populate it for real ("POKE10-10311-114"). Minting
 * a key from a search result would invent a SECOND identity for a product already tracked, and
 * every one would surface as a new listing. That is asserted first and hardest.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ShopifyAdapter = require('../src/adapters/shopify');

function makeAdapter(overrides = {}) {
  const a = new ShopifyAdapter({
    id: 'testshop', name: 'Test Shop', url: 'https://example.com',
    adapter: 'shopify', collections: [], searchKeywords: [], maxProducts: 2500, ...overrides,
  });
  a._cursorLoaded = true;
  a._handlesLoaded = true;   // no Redis in unit tests
  a._saveSweepCursor = async () => {};
  return a;
}

// One predictive-search result in Shopify's real shape: a handle, a formatted price, and
// deliberately NO variant sku.
const hit = (handle, title, price, available) => ({
  id: 111, handle, title, price, available,
  variants: [{ id: 222, title: 'Default Title', price, available }],
});

function stubSearch(a, byTerm) {
  a._fetchPage = async (url) => {
    const q = decodeURIComponent((url.match(/[?&]q=([^&]+)/) || [])[1] || '');
    return { products: byTerm[q] || [], changed: true };
  };
}

describe('search never invents a product identity', () => {
  test('a result whose handle is unknown is ignored', async () => {
    const a = makeAdapter();
    a._handleToSku.set('known-box', 'REAL-SKU-1');
    a.searchTerms = ['pokemon tcg'];
    stubSearch(a, { 'pokemon tcg': [hit('never-seen', 'Pokemon TCG Booster Box', '99.99', true)] });
    const products = {};
    await a._searchProducts(products);
    assert.deepStrictEqual(Object.keys(products), [],
      'search must not create a key — pagination owns identity');
  });

  test('a known handle updates the EXISTING sku, not a derived one', async () => {
    const a = makeAdapter();
    a._handleToSku.set('known-box', 'POKE10-10311-114');
    a.searchTerms = ['pokemon tcg'];
    stubSearch(a, { 'pokemon tcg': [hit('known-box', 'Pokemon TCG Booster Box', '99.99', true)] });
    const products = { 'POKE10-10311-114': { sku: 'POKE10-10311-114', price: 99.99, inStock: false } };
    await a._searchProducts(products);
    assert.deepStrictEqual(Object.keys(products), ['POKE10-10311-114']);
    assert.strictEqual(products['POKE10-10311-114'].inStock, true, 'stock is refreshed');
  });

  test('the handle index is built from pagination, first variant winning', () => {
    const a = makeAdapter();
    a.parseShopifyProduct({
      id: 900, handle: 'a-box', title: 'Pokemon TCG Booster Bundle', product_type: 'TCG', tags: [],
      variants: [{ id: 1, sku: 'REAL-1', price: '10.00', available: true },
        { id: 2, sku: 'REAL-2', price: '10.00', available: true }],
    }, {});
    assert.strictEqual(a._handleToSku.get('a-box'), 'REAL-1');
  });

  test('an out-of-scope product never enters the handle index', () => {
    const a = makeAdapter();
    a.parseShopifyProduct({
      id: 901, handle: 'sleeves', title: 'Pokemon TCG Card Sleeves 65ct', product_type: 'TCG', tags: [],
      variants: [{ id: 1, sku: 'S-1', price: '10.00', available: true }],
    }, {});
    assert.strictEqual(a._handleToSku.has('sleeves'), false);
  });
});

describe('search prices are not believed until they agree with pagination', () => {
  test('the known price is kept while the unit is unproven', async () => {
    const a = makeAdapter();
    a._handleToSku.set('b', 'SKU-B');
    a.searchTerms = ['pokemon tcg'];
    stubSearch(a, { 'pokemon tcg': [hit('b', 'Pokemon TCG Booster Box', '579.95', true)] });
    const products = { 'SKU-B': { sku: 'SKU-B', price: 579.95, inStock: false } };
    await a._searchProducts(products);
    assert.strictEqual(products['SKU-B'].price, 579.95);
  });

  test('a disagreement disqualifies the shop permanently', async () => {
    const a = makeAdapter();
    a._handleToSku.set('b', 'SKU-B');
    a.searchTerms = ['pokemon tcg'];
    // products.json says 579.95; search says 57995 — the cents/dollars mismatch.
    stubSearch(a, { 'pokemon tcg': [hit('b', 'Pokemon TCG Booster Box', '57995', true)] });
    const products = { 'SKU-B': { sku: 'SKU-B', price: 579.95, inStock: false } };
    await a._searchProducts(products);
    assert.strictEqual(products['SKU-B'].price, 579.95, 'the trusted price must survive');
    assert.strictEqual(a._searchPriceAgreements, -Infinity);
  });

  test('availability is taken even when the price is not', async () => {
    const a = makeAdapter();
    a._handleToSku.set('b', 'SKU-B');
    a.searchTerms = ['pokemon tcg'];
    stubSearch(a, { 'pokemon tcg': [hit('b', 'Pokemon TCG Booster Box', '57995', true)] });
    const products = { 'SKU-B': { sku: 'SKU-B', price: 579.95, inStock: false } };
    await a._searchProducts(products);
    assert.strictEqual(products['SKU-B'].inStock, true, 'stock is the point of the fast path');
  });
});

describe('search is an accelerator, never a dependency', () => {
  test('it stays idle until pagination has identified something', () => {
    const a = makeAdapter();
    assert.strictEqual(a._searchActive(), false);
    a._handleToSku.set('x', 'SKU-X');
    assert.strictEqual(a._searchActive(), true);
  });

  test('a collection-configured shop does not use it', () => {
    const a = makeAdapter({ collections: ['pokemon-new-releases'] });
    a._handleToSku.set('x', 'SKU-X');
    assert.strictEqual(a._searchActive(), false);
  });

  test('a 429 mid-search keeps what was already refreshed', async () => {
    const a = makeAdapter();
    a._handleToSku.set('b', 'SKU-B');
    a.searchTerms = ['t1', 't2'];
    let n = 0;
    a._fetchPage = async () => {
      n += 1;
      if (n === 1) return { products: [hit('b', 'Pokemon TCG Booster Box', '10.00', true)], changed: true };
      throw new Error('Rate limited (429): https://example.com/search/suggest.json');
    };
    const products = { 'SKU-B': { sku: 'SKU-B', price: 10, inStock: false } };
    const refreshed = await a._searchProducts(products);
    assert.strictEqual(refreshed, 1);
    assert.strictEqual(products['SKU-B'].inStock, true);
  });

  test('terms come from the shared file the big seven use', () => {
    const shared = require('../src/config/products.json');
    const a = makeAdapter();
    for (const q of [...(shared.searchQueries || []), ...(shared.setQueries || [])]) {
      assert.ok(a.searchTerms.includes(String(q).toLowerCase()),
        `"${q}" is sent to the big seven and must be sent to the shops too`);
    }
  });
});
