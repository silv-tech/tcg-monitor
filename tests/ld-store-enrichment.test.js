/**
 * The London Drugs store-stock enrichment pass.
 *
 * Two regressions are pinned here.
 *
 * 1. THE REVERSED FILTER. The pass used to select `p.inStock && p.url` — online-in-stock
 *    products with a product page. For a pickup-only chain that is backwards: shelf stock is
 *    independent of the website, so a product reading 0 online can be sitting in 28 stores. It
 *    also made in-store-only items structurally impossible to cover, because they have no
 *    product URL at all — which is exactly how two 30th Celebration SKUs were missed.
 *
 * 2. A FAILED LOOKUP IS NOT AN EMPTY SHELF. fetchInventory returns [] both when the request
 *    failed and when the product genuinely has no stock. Treating those alike would drop every
 *    store from an alert the moment one request 403s.
 *
 * The loop body is executed for real here rather than smoke-tested: an earlier version used
 * `sleep` without importing it, which `node --check` cannot catch and which only surfaces once
 * the loop actually runs — the same failure mode that crash-looped production on 2026-09-09.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const scraperApi = require('../src/utils/scraper-api');
const state = require('../src/core/state');
const LondonDrugsAdapter = require('../src/adapters/londondrugs');

state.getRedis = () => null;              // keep ioredis from holding the process open

const CFG = {
  id: 'londondrugs', name: 'London Drugs', url: 'https://www.londondrugs.com',
  adapter: 'londondrugs', intervalMs: 30000, proxyTier: 'residential', enabled: true, timing: {},
};

const inv = (rows) => JSON.stringify({ isSuccess: true, errors: [], data: rows });
const r = (locationCode, stockAvailable) => ({ locationCode, stockAvailable, softStockAvailable: null });

/** Run the pass to completion — it is deliberately fire-and-forget in production. */
async function runPass(adapter) {
  adapter._maybeEnrichStores();
  for (let i = 0; i < 200 && adapter._storesRunning; i++) await new Promise((res) => setTimeout(res, 25));
  assert.ok(!adapter._storesRunning, 'the pass never finished');
}

let requested = [];
beforeEach(() => {
  requested = [];
  scraperApi.isConfigured = () => true;
});

function adapterWith(responder) {
  scraperApi.scraperFetch = async (url) => { requested.push(url); return responder(url); };
  const a = new LondonDrugsAdapter(CFG);
  a._saveStores = async () => {};          // Redis is not under test here
  a._storesAt = 0;
  return a;
}

describe('which products get looked up', () => {
  test('a product that is OUT OF STOCK ONLINE is still checked — shelf stock is independent', async () => {
    const a = adapterWith(() => inv([r('021', 40)]));
    a._known = new Map([['L3445571', { sku: 'L3445571', inStock: false, url: null }]]);
    await runPass(a);
    assert.strictEqual(requested.length, 1,
      'the old pass filtered on p.inStock && p.url, which skipped exactly the products we were missing');
    assert.ok(a._stores.has('L3445571'));
  });

  test('a product with NO product page is still checked — that is what in-store-only means', async () => {
    const a = adapterWith(() => inv([r('068', 72)]));
    a._known = new Map([['L3445613', { sku: 'L3445613', inStock: false, url: undefined }]]);
    await runPass(a);
    assert.strictEqual(a._stores.get('L3445613')[0].name, 'Royal Oak Centre');
  });

  test('every tracked product is looked up, one request each', async () => {
    const a = adapterWith(() => inv([r('021', 5)]));
    a._known = new Map([['A', { sku: 'A' }], ['B', { sku: 'B' }], ['C', { sku: 'C' }]]);
    await runPass(a);
    assert.strictEqual(requested.length, 3);
  });

  test('the request asks for stores above the old 50-row cap', async () => {
    const a = adapterWith(() => inv([r('068', 72)]));
    a._known = new Map([['L3445613', { sku: 'L3445613' }]]);
    await runPass(a);
    assert.match(requested[0], /locationCodes=/);
    for (const code of ['068', '092', '751']) {
      assert.ok(requested[0].includes(code), `store ${code} must be requested`);
    }
  });
});

describe('a failed lookup leaves prior state alone', () => {
  test('a request that throws does not erase known store stock', async () => {
    const a = adapterWith(() => { throw new Error('403 blocked'); });
    a._known = new Map([['L3445613', { sku: 'L3445613' }]]);
    a._stores.set('L3445613', [{ code: '068', name: 'Royal Oak Centre', stockAvailable: 72 }]);
    await runPass(a);
    assert.strictEqual(a._stores.get('L3445613')[0].stockAvailable, 72,
      'one 403 must not turn a stocked product into "nowhere in stock"');
  });

  test('a genuine all-zero response DOES clear the product', async () => {
    const a = adapterWith(() => inv([r('021', 0), r('068', 0)]));
    a._known = new Map([['L3445613', { sku: 'L3445613' }]]);
    a._stores.set('L3445613', [{ code: '068', name: 'Royal Oak Centre', stockAvailable: 72 }]);
    await runPass(a);
    assert.ok(!a._stores.has('L3445613'), 'sold out everywhere is a real state and must be recorded');
  });

  test('one product failing does not stop the rest of the pass', async () => {
    let n = 0;
    const a = adapterWith(() => { n++; if (n === 1) throw new Error('403'); return inv([r('021', 9)]); });
    a._known = new Map([['A', { sku: 'A' }], ['B', { sku: 'B' }]]);
    await runPass(a);
    assert.strictEqual(requested.length, 2);
    assert.ok(a._stores.has('B'));
  });
});

describe('the pass guards itself', () => {
  test('with no scraper configured it does nothing rather than throwing', async () => {
    scraperApi.isConfigured = () => false;
    const a = adapterWith(() => inv([r('021', 1)]));
    a._known = new Map([['A', { sku: 'A' }]]);
    a._maybeEnrichStores();
    assert.strictEqual(requested.length, 0);
    assert.ok(!a._storesRunning);
  });

  test('an empty catalogue does not consume the interval', async () => {
    const a = adapterWith(() => inv([]));
    a._known = new Map();
    a._maybeEnrichStores();
    assert.strictEqual(a._storesAt, 0, 'stamping the clock on an empty pass delayed store data by a full interval');
  });

  test('it will not run twice concurrently', async () => {
    const a = adapterWith(() => inv([r('021', 1)]));
    a._known = new Map([['A', { sku: 'A' }], ['B', { sku: 'B' }]]);
    a._maybeEnrichStores();
    a._maybeEnrichStores();
    for (let i = 0; i < 200 && a._storesRunning; i++) await new Promise((res) => setTimeout(res, 25));
    assert.strictEqual(requested.length, 2, 'a second overlapping pass would double the credit spend');
  });
});
