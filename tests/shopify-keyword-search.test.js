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

describe('search resolves products pagination has not reached yet', () => {
  // Both shops asked about returned twenty search results and matched none of them: every
  // one was a real sealed product (Stellar Crown ETB, Mega Evolution ETB) that the rotation
  // had not walked deep enough to identify. Discarding those made search useless exactly
  // where it was most needed.
  //
  // Resolution goes through products/<handle>.js, which returns the SAME product id, variant
  // id and sku that products.json does — so the key derived here is identical to the one
  // pagination would produce and no second identity can appear.
  const fullProduct = (handle, title, sku, price, available) => ({
    id: 9039916433623, handle, title, product_type: 'TCG', tags: [],
    variants: [{ id: 47185918755031, sku, price, available }],
    images: [],
  });

  function stub(a, searchResults, byHandle) {
    a._fetchPage = async (url) => {
      if (/suggest\.json/.test(url)) return { products: searchResults, changed: true };
      const h = (url.match(/\/products\/([^.]+)\.js/) || [])[1];
      if (byHandle[h]) return { products: [byHandle[h]], changed: true };
      throw new Error('404');
    };
  }

  test('an unknown in-scope product is resolved and keyed exactly as pagination would', async () => {
    const a = makeAdapter();
    a._handleToSku.set('seed', 'SEED-SKU');       // makes search active
    a.searchTerms = ['pokemon tcg'];
    const handle = 'pokemon-tcg-mega-evolution-elite-trainer-box-mega-lucario';
    stub(a,
      [hit(handle, 'Pokemon TCG Mega Evolution Elite Trainer Box', '179.95', true)],
      { [handle]: fullProduct(handle, 'Pokemon TCG Mega Evolution Elite Trainer Box', null, 17995, true) });

    const products = {};
    await a._searchProducts(products);
    // sku is null on this shop, so pagination's fallback key applies.
    assert.deepStrictEqual(Object.keys(products), ['9039916433623-47185918755031']);
    assert.strictEqual(products['9039916433623-47185918755031'].inStock, true);
    assert.strictEqual(a._handleToSku.get(handle), '9039916433623-47185918755031',
      'and it is indexed so later ticks refresh it without another lookup');
  });

  test('a real sku from the product endpoint wins, matching pagination', async () => {
    const a = makeAdapter();
    a._handleToSku.set('seed', 'SEED-SKU');
    a.searchTerms = ['pokemon tcg'];
    const handle = 'poke-box';
    stub(a, [hit(handle, 'Pokemon TCG Booster Box', '99.99', true)],
      { [handle]: fullProduct(handle, 'Pokemon TCG Booster Box', 'POKE10-10311-114', 9999, true) });

    const products = {};
    await a._searchProducts(products);
    assert.deepStrictEqual(Object.keys(products), ['POKE10-10311-114']);
  });

  test('an out-of-scope result is never resolved — no wasted request', async () => {
    const a = makeAdapter();
    a._handleToSku.set('seed', 'SEED-SKU');
    a.searchTerms = ['pokemon tcg'];
    let lookups = 0;
    a._fetchPage = async (url) => {
      if (/suggest\.json/.test(url)) {
        return { products: [hit('sleeves', 'Pokemon TCG Card Sleeves 65ct', '9.99', true)], changed: true };
      }
      lookups += 1;
      return { products: [], changed: true };
    };
    await a._searchProducts({});
    assert.strictEqual(lookups, 0, 'accessories must not cost a lookup');
  });

  test('discovery is bounded per tick', async () => {
    const a = makeAdapter();
    a._handleToSku.set('seed', 'SEED-SKU');
    a.searchTerms = ['pokemon tcg'];
    const many = Array.from({ length: 10 }, (_, i) =>
      hit(`box-${i}`, `Pokemon TCG Booster Box ${i}`, '99.99', true));
    let lookups = 0;
    a._fetchPage = async (url) => {
      if (/suggest\.json/.test(url)) return { products: many, changed: true };
      lookups += 1;
      const h = (url.match(/\/products\/([^.]+)\.js/) || [])[1];
      return { products: [fullProduct(h, `Pokemon TCG Booster Box`, `SKU-${h}`, 9999, true)], changed: true };
    };
    await a._searchProducts({});
    assert.ok(lookups <= 2, `at most two lookups per tick, got ${lookups}`);
  });

  test('a 429 during resolution stops the tick without throwing', async () => {
    const a = makeAdapter();
    a._handleToSku.set('seed', 'SEED-SKU');
    a.searchTerms = ['pokemon tcg'];
    a._fetchPage = async (url) => {
      if (/suggest\.json/.test(url)) {
        return { products: [hit('box', 'Pokemon TCG Booster Box', '99.99', true)], changed: true };
      }
      throw new Error('Rate limited (429): https://example.com/products/box.js');
    };
    await assert.doesNotReject(() => a._searchProducts({}));
    assert.strictEqual(a._searchRateLimited, true);
  });
});

describe('Ajax prices are converted to the store unit, never guessed', () => {
  // Shopify's products/<handle>.js always quotes cents. products.json does not — hobbiesville
  // quotes cents there, kanzengames quotes dollars. Passing the raw Ajax price through meant
  // the store divisor was skipped or double-applied depending on the shop, and kanzengames
  // reported a $179.95 Elite Trainer Box as $17,995. Caught by spot-checking stored rows
  // against the live listings, not by any test that existed at the time.
  const ajax = {
    id: 1, handle: 'h', title: 'Pokemon TCG Elite Trainer Box', product_type: 'TCG', tags: [],
    images: [], variants: [{ id: 2, sku: null, price: 17995, available: true }],
  };

  test('a dollars store ends up at 179.95', () => {
    const a = makeAdapter();
    a._priceUnitLocked = true; a._pricesAreCents = false;
    const out = {};
    a.parseShopifyProduct(a._normaliseAjaxPrices(ajax), out);
    assert.strictEqual(Object.values(out)[0].price, 179.95);
  });

  test('a cents store also ends up at 179.95', () => {
    const a = makeAdapter();
    a._priceUnitLocked = true; a._pricesAreCents = true;
    const out = {};
    a.parseShopifyProduct(a._normaliseAjaxPrices(ajax), out);
    assert.strictEqual(Object.values(out)[0].price, 179.95);
  });

  test('an unestablished unit yields NO price rather than a 100x guess', () => {
    const a = makeAdapter();
    a._priceUnitLocked = false;
    const out = {};
    a.parseShopifyProduct(a._normaliseAjaxPrices(ajax), out);
    assert.strictEqual(Object.values(out)[0].price, null,
      'a missing price costs one field; a wrong one fires a false price-change alert');
  });

  test('the product is still tracked even without a price', () => {
    const a = makeAdapter();
    a._priceUnitLocked = false;
    const out = {};
    a.parseShopifyProduct(a._normaliseAjaxPrices(ajax), out);
    assert.strictEqual(Object.keys(out).length, 1);
    assert.strictEqual(Object.values(out)[0].inStock, true, 'stock is still accurate');
  });
});
