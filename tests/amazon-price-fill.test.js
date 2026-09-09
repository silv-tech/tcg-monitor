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

// A search item as _parseSearchHtml ACTUALLY produces it for a priceless tile.
//
// The first version of these tests built the item as { inStock: true, price: null }, and every
// one of them passed — while the feature could not fire even once in production. A tile with no
// price is marked inStock:false by construction (a price is the only stock signal a tile
// carries), so "inStock && no price" is unsatisfiable on this path. Measured on 90 live tiles:
// 43 priceless, 0 of them in stock. The shape below is the real one.
function item(over = {}) {
  return {
    asin: 'B0GW2DK37Q',
    name: 'Pokémon TCG: First Partner Illustration Collection',
    price: null,
    inStock: false,
    _priceUnknown: true,
    image: 'https://m.media-amazon.com/x.jpg',
    _alt: '',
    ...over,
  };
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
    // The tile said out of stock only because it showed no price. AOD read a live buy box, so
    // the stock flag has to be corrected too — a real price on a false OOS still never alerts,
    // which was the entire miss.
    assert.strictEqual(products['B0GW2DK37Q'].inStock, true, 'AOD settles stock, not just price');
    assert.strictEqual(products['B0GW2DK37Q'].canAddToCart, true);
  });

  test('a priced item is NOT looked up (no wasted fetch)', async () => {
    const a = adapter(); wire(a, { items: [item({ price: 24.99, inStock: true, _priceUnknown: false })], price: 99 });
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

/**
 * The gap that let a passing suite hide a feature that never ran: nothing asserted that the
 * parser can actually produce the shape the fill logic waits for. These drive real Amazon
 * markup through the real parser.
 */
describe('amazon price-fill: the trigger is reachable from real search HTML', () => {
  const fs = require('fs');
  const path = require('path');
  const HTML = fs.readFileSync(path.join(__dirname, 'fixtures/amazon-search-tiles.html'), 'utf8');

  test('a real priceless tile is flagged, a real priced tile is not', () => {
    const items = AmazonAdapter.prototype._parseSearchHtml.call({}, HTML);
    assert.strictEqual(items.length, 2);
    const priceless = items.find((i) => i._priceUnknown);
    const priced = items.find((i) => !i._priceUnknown);
    assert.ok(priceless, 'the parser must flag a tile that shows no price');
    assert.strictEqual(priceless.price, null);
    assert.strictEqual(priceless.inStock, false, 'still not treated as in stock on tile alone');
    assert.ok(priced.price > 0);
  });

  test('that tile reaches the fill queue end to end', async () => {
    const a = adapter();
    const items = AmazonAdapter.prototype._parseSearchHtml.call({}, HTML);
    const checked = [];
    a._freeSearch = async () => items;
    a._stealthCheckAsin = async (asin) => {
      checked.push(asin);
      return { name: 'x', price: 74.95, inStock: true, olid: 'o' };
    };
    const products = {};
    await a._runDiscovery(products);

    const priceless = items.find((i) => i._priceUnknown);
    assert.deepStrictEqual(checked, [priceless.asin], 'exactly the priceless tile is looked up');
    assert.strictEqual(products[priceless.asin].price, 74.95);
    assert.strictEqual(products[priceless.asin].inStock, true);
  });

  test('a failed lookup leaves the tile exactly as it was — never a false in-stock', async () => {
    const a = adapter();
    const items = AmazonAdapter.prototype._parseSearchHtml.call({}, HTML);
    a._freeSearch = async () => items;
    a._stealthCheckAsin = async () => null;
    const products = {};
    await a._runDiscovery(products);
    const priceless = items.find((i) => i._priceUnknown);
    assert.strictEqual(products[priceless.asin].inStock, false);
    assert.ok(!(products[priceless.asin].price > 0));
  });
});

/**
 * The follow-on fault, found by asking what happens on the NEXT poll.
 *
 * _buildFromSearch set inStock straight from the tile. A priceless tile reports false, so the
 * poll after a successful price-fill overwrote AOD's true with false; the item was no longer
 * queued for a lookup (it had a cached price by then), and the five-minute AOD sweep flipped it
 * back to true. Restock, out-of-stock, restock — a flap on a paid channel, which is worse than
 * the silent miss it replaced.
 */
describe('amazon price-fill: a resolved item stays resolved', () => {
  test('a second poll on the same priceless tile does not flip it out of stock', async () => {
    const a = adapter();
    a._freeSearch = async () => [item()];
    a._stealthCheckAsin = async () => ({ name: 'x', price: 39.95, inStock: true, olid: 'o' });

    const first = {};
    await a._runDiscovery(first);
    assert.strictEqual(first['B0GW2DK37Q'].inStock, true, 'precondition: the fill worked');

    // Same tile again: still no price shown, and now no lookup because the price is cached.
    const checked = [];
    a._stealthCheckAsin = async (asin) => { checked.push(asin); return null; };
    const second = {};
    await a._runDiscovery(second);

    assert.strictEqual(checked.length, 0, 'cached price means no second lookup');
    assert.strictEqual(second['B0GW2DK37Q'].inStock, true, 'must not flap back to out of stock');
    assert.strictEqual(second['B0GW2DK37Q'].price, 39.95);
  });

  test('a tile that never resolved stays out of stock', async () => {
    const a = adapter();
    a._freeSearch = async () => [item()];
    a._stealthCheckAsin = async () => null;
    const products = {};
    await a._runDiscovery(products);
    assert.strictEqual(products['B0GW2DK37Q'].inStock, false, 'unknown is not in stock');
  });

  test('a real tile that says "unavailable" is still out of stock', async () => {
    const a = adapter();
    a._freeSearch = async () => [item({ _priceUnknown: false, inStock: false, price: null })];
    a._stealthCheckAsin = async () => ({ name: 'x', price: 10, inStock: true, olid: 'o' });
    const products = {};
    await a._runDiscovery(products);
    assert.strictEqual(products['B0GW2DK37Q'].inStock, false, 'an explicit OOS tile is believed');
  });
});

/**
 * The alert flood, and why withholding beats guessing.
 *
 * On 2026-09-09 widening the query list took Amazon from ~80 to ~205 ASINs. Every unresolved
 * priceless tile landed in Redis as "out of stock" — a guess we had no evidence for — and each
 * time the bounded price-fill later resolved one, the diff saw false -> true and fired a
 * RESTOCK. 21 alerts in 24s, twice, muting the retailer for ten minutes each time and
 * suppressing genuine alerts along with the noise (events.js:31 is the transition that fires).
 *
 * An item whose stock we have not established is now simply not reported.
 */
describe('amazon: an unresolved item is withheld, not guessed as out of stock', () => {
  function adapter() {
    const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon', url: 'https://www.amazon.ca', intervalMs: 6000 });
    a.searchQueries = ['pokemon'];
    a._logSearchRate = () => {}; a._recordSearchResult = () => {}; a.reportFreshness = () => {};
    a._monitorKnownAsins = async () => {};
    a._purgeOutOfScopeState = async () => {};
    a._lastAodSweepAt = Date.now();
    return a;
  }

  test('a priceless tile whose fill has not succeeded is not reported at all', async () => {
    const a = adapter();
    a._freeSearch = async () => [item()];
    a._stealthCheckAsin = async () => null;          // fill fails
    const products = await a.fetchProducts();
    assert.ok(!('B0GW2DK37Q' in products),
      'an unknown-stock item must not be published as out of stock');
    assert.ok(a._knownProducts.has('B0GW2DK37Q'), 'but it is kept, to retry next poll');
  });

  test('once the fill resolves it, it IS reported — with real stock and price', async () => {
    const a = adapter();
    a._freeSearch = async () => [item()];
    a._stealthCheckAsin = async () => ({ name: 'x', price: 39.95, inStock: true, olid: 'o' });
    const products = await a.fetchProducts();
    assert.strictEqual(products['B0GW2DK37Q'].price, 39.95);
    assert.strictEqual(products['B0GW2DK37Q'].inStock, true);
  });

  test('a normally-priced item is unaffected', async () => {
    const a = adapter();
    a._freeSearch = async () => [item({ price: 24.99, inStock: true, _priceUnknown: false })];
    a._stealthCheckAsin = async () => null;
    const products = await a.fetchProducts();
    assert.strictEqual(products['B0GW2DK37Q'].price, 24.99);
  });

  test('an explicitly out-of-stock tile is still reported as out of stock', async () => {
    // _priceUnknown is false when the tile says "Currently unavailable" — that IS evidence.
    const a = adapter();
    a._freeSearch = async () => [item({ _priceUnknown: false, inStock: false })];
    a._stealthCheckAsin = async () => null;
    const products = await a.fetchProducts();
    assert.ok('B0GW2DK37Q' in products, 'a real OOS observation must still be published');
    assert.strictEqual(products['B0GW2DK37Q'].inStock, false);
  });
});

/**
 * The hole the first withhold fix left open.
 *
 * The filter was a step at the END of fetchProducts, and the search-backoff early return jumped
 * straight past it — dumping the raw _knownProducts map, unresolved guesses and all, on every
 * poll for the 60-900s a backoff lasts. With one query per poll a single failed exit is enough
 * to enter that state, so the hole was hit often: it wrote ~125 fresh inStock:false guesses to
 * Redis silently (price-0 events are dropped by delivery, and there is no out-of-stock event),
 * each one a future RESTOCK the moment AOD resolved it. That is why the flood recurred an hour
 * after the fix. The filter is now a WRAPPER, so every return path is covered.
 */
describe('amazon: no return path can publish an unresolved guess', () => {
  function adapter() {
    const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon', url: 'https://www.amazon.ca', intervalMs: 6000 });
    a._logSearchRate = () => {}; a._recordSearchResult = () => {}; a.reportFreshness = () => {};
    a._monitorKnownAsins = async () => {};
    a._purgeOutOfScopeState = async () => {};
    a._lastAodSweepAt = Date.now();
    return a;
  }

  test('the search-backoff early return withholds unresolved items', async () => {
    const a = adapter();
    // An unresolved guess and a real product, both already known.
    a._knownProducts.set('B0UNRESOLV', {
      sku: 'B0UNRESOLV', name: 'Pokemon TCG: Something', price: 0, inStock: false,
      _priceUnknown: true, category: 'pokemon',
    });
    a._knownProducts.set('B0REAL0001', {
      sku: 'B0REAL0001', name: 'Pokemon TCG: Real Box', price: 42.5, inStock: true,
      _priceUnknown: false, category: 'pokemon',
    });
    a._searchBlockedUntil = Date.now() + 60000;   // Amazon is refusing search

    const products = await a.fetchProducts();
    assert.ok(!('B0UNRESOLV' in products),
      'a guess must not be published just because search is backing off');
    assert.ok('B0REAL0001' in products, 'the resolved product is still reported');
  });

  test('a resolved-but-priceless-tile item is published once it has a real price', async () => {
    const a = adapter();
    a._knownProducts.set('B0FILLED01', {
      sku: 'B0FILLED01', name: 'Pokemon TCG: Filled', price: 39.95, inStock: true,
      _priceUnknown: true, category: 'pokemon',
    });
    a._searchBlockedUntil = Date.now() + 60000;
    const products = await a.fetchProducts();
    assert.ok('B0FILLED01' in products,
      '_priceUnknown with a real price means AOD resolved it — that is publishable');
  });
});
