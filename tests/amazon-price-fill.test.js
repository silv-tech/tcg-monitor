/**
 * Amazon: fill the price for buyable-but-priceless items so a real restock is not dropped.
 *
 * The miss (client-reported 2026-09-08): B0GW2DK37Q — "First Partner Illustration Collection
 * Series 2" — is listed in stock on Amazon's search grid but shows NO price there; Amazon prices
 * it only on the product's own page. Our search stored price 0, and delivery's no-price filter
 * (which does NOT exempt RESTOCK) dropped the alert, so we stayed silent while a competitor that
 * reads the product page caught it. Verified in our own state: inStock true, price 0.
 *
 * The fix: when discovery sees an item in stock but with no price, resolve the price from the
 * product page (AOD, free path) before the poll returns — so the restock event carries a real
 * price and delivery lets it through. Bounded per poll, cached once resolved, and on failure the
 * item stays at 0 (suppressed as before — never a wrong price).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');

function adapter() {
  const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000, proxyTier: 'none' });
  a.searchQueries = ['pokemon'];
  a._logSearchRate = () => {};
  a._recordSearchResult = () => {};
  a.reportFreshness = () => {};
  return a;
}

// A search item that passes _buildFromSearch's filters (Pokémon, TCG, not an accessory).
function item(over = {}) {
  return { asin: 'B0GW2DK37Q', name: 'Pokémon TCG: First Partner Illustration Collection', price: null, inStock: true, image: 'https://m.media-amazon.com/x.jpg', _alt: '', ...over };
}

describe('amazon price-fill for buyable-but-priceless items', () => {
  let calls;
  function wire(a, { items, price }) {
    calls = { search: 0, check: [] };
    a._freeSearch = async () => { calls.search++; return items; };
    a._stealthCheckAsin = async (asin) => { calls.check.push(asin); return price === undefined ? null : { name: 'x', price, inStock: true, olid: 'o' }; };
  }
  beforeEach(() => { calls = null; });

  test('in stock + no price => price resolved from the product page', async () => {
    const a = adapter(); wire(a, { items: [item()], price: 39.95 });
    const products = {};
    await a._runDiscovery(products);
    assert.deepStrictEqual(calls.check, ['B0GW2DK37Q'], 'the priceless item is looked up once');
    assert.strictEqual(products['B0GW2DK37Q'].price, 39.95, 'the real price is filled in');
    assert.strictEqual(products['B0GW2DK37Q'].inStock, true);
  });

  test('a priced item is NOT looked up (no wasted fetch)', async () => {
    const a = adapter(); wire(a, { items: [item({ price: 24.99 })], price: 99 });
    await a._runDiscovery({});
    assert.strictEqual(calls.check.length, 0, 'priced items never trigger a product-page fetch');
  });

  test('lookup with no price leaves the item at 0 — suppressed as before, no wrong price', async () => {
    const a = adapter(); wire(a, { items: [item()], price: undefined }); // _stealthCheckAsin returns null
    const products = {};
    await a._runDiscovery(products);
    assert.strictEqual(calls.check.length, 1);
    assert.ok(!(products['B0GW2DK37Q'].price > 0), 'no price invented; stays suppressed');
  });

  test('resolved price is cached so the next poll does not re-fetch', async () => {
    const a = adapter(); wire(a, { items: [item()], price: 39.95 });
    await a._runDiscovery({});           // poll 1: resolves + caches
    const firstChecks = calls.check.length;
    // poll 2: search still returns no price, but _buildFromSearch now reuses the cached price
    a._freeSearch = async () => [item()];
    calls.check = [];
    await a._runDiscovery({});
    assert.strictEqual(firstChecks, 1);
    assert.strictEqual(calls.check.length, 0, 'cached price means no second product-page fetch');
  });

  test('bounded per poll — never more product-page fetches than the cap', async () => {
    const a = adapter();
    const many = Array.from({ length: 10 }, (_, i) => item({ asin: `B0PL${i}`, name: `Pokémon TCG: Booster Box ${i}` }));
    wire(a, { items: many, price: 50 });
    await a._runDiscovery({});
    assert.ok(calls.check.length <= 3, `looked up ${calls.check.length}, cap is 3`);
  });

  test('skipped entirely while AOD is throttling', async () => {
    const a = adapter(); wire(a, { items: [item()], price: 39.95 });
    a._lastFetchThrottled = true;
    await a._runDiscovery({});
    assert.strictEqual(calls.check.length, 0, 'do not hammer AOD when it is already 503ing');
  });
});
