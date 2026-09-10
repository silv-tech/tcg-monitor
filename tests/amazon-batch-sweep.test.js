/**
 * Batch-ASIN stock sweep — the FREE replacement for the blocked AOD per-ASIN checker.
 *
 * THE MISS THIS FIXES (verified live 2026-09-10): tracked ASIN B0H78BB9TY (Pokémon 30th Celebration
 * ETB) restocked at $89.99, a competitor alerted it, we sent NOTHING. Cause: AOD (the only per-ASIN
 * stock refresh) was blocked for hours, and this page-2-ranked ETB is never surfaced by keyword
 * relevance — so its stored inStock:false row sat stale ~15h and never flipped, so no RESTOCK fired.
 * No whitelist was involved; the row simply went unchecked.
 *
 * The sweep asks /s for pipe-joined ASIN batches (Amazon's OR operator) so EVERY tracked ASIN is
 * stock-checked by exact id every ~3 min, over the same free endpoint + ISP pool as keyword search,
 * with no AOD. These tests assert: the exact restock flips, the URL shape, cursor pacing (rate-flat),
 * the grid-based challenge guard, and — hardest — that a challenge/empty page can NEVER flip OOS.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');

function adapter() {
  const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000, proxyTier: 'none', watchlist: [] });
  a.reportFreshness = () => {};
  return a;
}

describe('the exact restock that was missed now flips via the batch sweep (no AOD)', () => {
  test('B0H78BB9TY inStock:false -> true when the batch tile shows it priced + in stock', async () => {
    const a = adapter();
    a._knownProducts.set('B0H78BB9TY', { sku: 'B0H78BB9TY', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 229, inStock: false, category: 'pokemon' });
    // The batch /s tile: priced and available (no AOD needed — a priced in-stock tile asserts stock).
    a._freeSearch = async (q, n, p, opts) => {
      assert.ok(opts.asinMode, 'sweep calls _freeSearch in asinMode');
      assert.ok(q.includes('B0H78BB9TY'), 'the tracked ASIN is in the batch');
      return [{ asin: 'B0H78BB9TY', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 89.99, inStock: true, image: '', _priceUnknown: false }];
    };
    const products = {};
    await a._runAsinSweep(products);
    assert.strictEqual(products.B0H78BB9TY.inStock, true, 'the sweep flips it in stock — this is the RESTOCK the diff fires');
    assert.strictEqual(products.B0H78BB9TY.price, 89.99, 'and corrects the stale $229 price');
    // the poll-adapter diff sees stored false -> new true => RESTOCK. Confirm _knownProducts updated too.
    assert.strictEqual(a._knownProducts.get('B0H78BB9TY').inStock, true);
  });
});

describe('URL shape: pipe-joined ASINs, no department filter', () => {
  test('_freeSearch(asinMode) builds k=<ASINs> with %7C and no &i=toys/&s/&page', async () => {
    const a = adapter();
    let captured = '';
    const { stealthGet } = require('../src/utils/stealth-http');
    // Intercept _searchOnce's fetch by stubbing stealthGet via the module — simpler: stub _searchOnce
    a._searchOnce = async (url) => { captured = url; return []; };
    await a._freeSearch('B0AAA111111|B0BBB222222', false, 1, { asinMode: true });
    assert.ok(captured.includes('k=B0AAA111111%7CB0BBB222222'), `pipe encoded as %7C — got ${captured}`);
    assert.ok(!captured.includes('&i=toys'), 'no department filter on the ASIN path (would hide re-categorised items)');
    assert.ok(!captured.includes('&s=date-desc') && !captured.includes('&page='), 'no sort/page params in asinMode');
  });

  test('keyword mode is unchanged — still carries &i=toys', async () => {
    const a = adapter();
    let captured = '';
    a._searchOnce = async (url) => { captured = url; return []; };
    await a._freeSearch('pokemon booster box', false, 1);
    assert.ok(captured.includes('&i=toys'), 'keyword path keeps its department filter');
  });
});

describe('cursor pacing keeps /s volume flat (a few chunks per poll, full sweep over many polls)', () => {
  test('one batch per poll by default; the cursor walks the whole catalogue and wraps', async () => {
    const a = adapter();
    for (let i = 0; i < 50; i++) a._knownProducts.set('B0' + String(i).padStart(8, '0'), { sku: 'B0' + i, inStock: false });
    const seen = new Set();
    a._freeSearch = async (q) => { for (const asin of q.split('|')) seen.add(asin); return []; };
    // 50 ASINs / 20 per batch = 3 chunks. One batch/poll => 3 polls to cover all, then wrap.
    const startCursor = [];
    for (let poll = 0; poll < 3; poll++) { startCursor.push(a._asinSweepCursor); await a._runAsinSweep({}); }
    assert.deepStrictEqual(startCursor, [0, 1, 2], 'exactly one chunk advanced per poll (rate-flat, not a burst)');
    assert.strictEqual(seen.size, 50, 'every tracked ASIN is covered within a full rotation');
    assert.strictEqual(a._asinSweepCursor, 0, 'cursor wraps back to the start after a full pass');
  });
});

describe('a challenge / empty page can NEVER flip a batch of ASINs out of stock', () => {
  test('_freeSearch returning null (challenge) leaves products empty — carry-forward, no OOS', async () => {
    const a = adapter();
    a._knownProducts.set('B0INSTOCK01', { sku: 'B0INSTOCK01', inStock: true, price: 50, category: 'pokemon' });
    a._freeSearch = async () => null; // WAF challenge / no grid
    const products = {};
    await a._runAsinSweep(products);
    assert.strictEqual(Object.keys(products).length, 0, 'a challenge batch contributes NOTHING — the in-stock row is carried forward elsewhere, never flipped OOS');
  });

  test('a batch tile with no price never asserts in-stock (withhold, not guess)', async () => {
    const a = adapter();
    a._knownProducts.set('B0AMBIG0001', { sku: 'B0AMBIG0001', name: 'Pokemon TCG Box', price: 0, inStock: false, category: 'pokemon' });
    // A priceless tile: _buildFromSearch must keep cached inStock:false, not flip it true.
    a._freeSearch = async () => [{ asin: 'B0AMBIG0001', name: 'Pokemon TCG Box', price: null, inStock: false, image: '', _priceUnknown: true }];
    const products = {};
    await a._runAsinSweep(products);
    // Either not surfaced or surfaced-but-still-false; the invariant is it is NOT asserted in stock.
    assert.notStrictEqual(products.B0AMBIG0001?.inStock, true, 'a price-unknown tile must never manufacture an in-stock');
  });
});

describe('single-flight: an orphaned sweep cannot race a fresh one', () => {
  test('a second concurrent _runAsinSweep no-ops while the first is in flight', async () => {
    const a = adapter();
    for (let i = 0; i < 20; i++) a._knownProducts.set('B0' + String(i).padStart(8, '0'), { sku: 'B0' + i, inStock: false });
    let inner = 0;
    a._runAsinSweepInner = async () => { inner++; await new Promise(r => setTimeout(r, 40)); };
    const first = a._runAsinSweep({});
    const second = a._runAsinSweep({});
    await Promise.all([first, second]);
    assert.strictEqual(inner, 1, 'only one sweep body runs at a time');
    assert.strictEqual(a._asinSweepInFlight, false, 'guard released after completion');
  });

  test('the guard is released even if the sweep body throws', async () => {
    const a = adapter();
    a._knownProducts.set('B0X', { sku: 'B0X', inStock: false });
    a._runAsinSweepInner = async () => { throw new Error('boom'); };
    await assert.rejects(() => a._runAsinSweep({}), /boom/);
    assert.strictEqual(a._asinSweepInFlight, false, 'finally releases the guard on error');
  });
});

describe('the sweep is reversible and safe when empty', () => {
  test('no tracked ASINs => no-op', async () => {
    const a = adapter();
    let called = false;
    a._freeSearch = async () => { called = true; return []; };
    await a._runAsinSweep({});
    assert.strictEqual(called, false, 'nothing to sweep, no /s request');
  });
});
