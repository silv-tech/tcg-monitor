/**
 * Rotating catalogue sweep.
 *
 * fetchAllProducts used to stop at `page > 10` — a flat 2,500-product ceiling that ignored the
 * configured maxProducts (kanzengames asked for 4,000 and silently received 2,500).
 *
 * Hobbiesville showed the cost. The shop carries 13,750 products over 55 pages; of its
 * in-scope sealed products, 21 were inside the first ten pages and 109 were beyond them,
 * several of those in stock. They could never alert, because nothing ever read them.
 *
 * The fix must satisfy three things at once, and each is asserted below:
 *   1. the whole catalogue is eventually covered,
 *   2. the per-sweep request burst does NOT grow — that burst is what caused 429s before,
 *   3. a windowed sweep is reported as PARTIAL, or the pages outside the window would look
 *      like products that vanished and come back as false restocks.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ShopifyAdapter = require('../src/adapters/shopify');

// A fake shop of `total` products, 250 per page, that records which pages were asked for.
function makeAdapter(total, maxProducts) {
  const a = new ShopifyAdapter({
    id: 'testshop', name: 'Test Shop', url: 'https://example.com',
    adapter: 'shopify', collections: [], searchKeywords: [], maxProducts,
  });
  a.requested = [];
  a._fetchPage = async (url) => {
    const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
    a.requested.push(page);
    const start = (page - 1) * 250;
    const n = Math.max(0, Math.min(250, total - start));
    const products = Array.from({ length: n }, (_, i) => ({
      id: start + i, title: `Pokemon TCG Booster Bundle ${start + i}`,
      handle: `p${start + i}`, product_type: 'TCG', tags: [],
      variants: [{ id: start + i, price: '49.99', available: true }],
    }));
    return { products };
  };
  a._detectPriceUnit = () => {};
  // No Redis in unit tests: the cursor is an optimisation, and leaving it live makes every
  // sweep test wait on a connection that will never come.
  a._cursorLoaded = true;
  a._saveSweepCursor = async () => {};
  a.parseShopifyProduct = (item, out) => { out[String(item.id)] = { sku: String(item.id) }; };
  return a;
}

describe('the window is bounded', () => {
  test('never asks for more pages in one sweep than the old hard ceiling', async () => {
    const a = makeAdapter(13750, 14000);
    await a.fetchAllProducts({});
    assert.strictEqual(a.requested.length, 10,
      'the burst must stay at 10 requests — widening it is what caused 429s');
  });
});

describe('the window rotates until the whole catalogue is covered', () => {
  test('successive sweeps advance and eventually see every page', async () => {
    const a = makeAdapter(13750, 14000);   // 55 pages
    const seen = new Set();
    for (let sweep = 0; sweep < 6; sweep++) {
      a.requested = [];
      await a.fetchAllProducts({});
      a.requested.forEach((p) => seen.add(p));
    }
    for (let p = 1; p <= 55; p++) {
      assert.ok(seen.has(p), `page ${p} must be reached within a full rotation`);
    }
  });

  test('it wraps back to the start after the end', async () => {
    const a = makeAdapter(13750, 14000);
    for (let sweep = 0; sweep < 6; sweep++) await a.fetchAllProducts({});
    a.requested = [];
    await a.fetchAllProducts({});
    assert.strictEqual(a.requested[0], 1, 'after the end the cursor returns to page 1');
  });

  test('maxProducts is honoured instead of being overridden by a hard cap', async () => {
    const a = makeAdapter(13750, 4000);    // ceiling of 16 pages
    const seen = new Set();
    for (let sweep = 0; sweep < 4; sweep++) {
      a.requested = [];
      await a.fetchAllProducts({});
      a.requested.forEach((p) => seen.add(p));
    }
    assert.ok(Math.max(...seen) <= 16, 'must not read past the configured ceiling');
    assert.ok(seen.has(16), 'must be able to reach the configured ceiling');
  });
});

describe('completeness is reported honestly', () => {
  test('a shop that fits in one window reports COMPLETE', async () => {
    const a = makeAdapter(500, 2500);      // 2 pages
    assert.strictEqual(await a.fetchAllProducts({}), true);
  });

  test('a shop deeper than one window reports PARTIAL', async () => {
    const a = makeAdapter(13750, 14000);
    assert.strictEqual(await a.fetchAllProducts({}), false,
      'a slice must never be reported as a complete view of the catalogue');
  });

  test('a later window that happens to hit the end is still PARTIAL', async () => {
    // It reached the end, but did not start at page 1, so it never saw pages 1-50.
    const a = makeAdapter(13750, 14000);
    let covered = null;
    for (let sweep = 0; sweep < 6; sweep++) covered = await a.fetchAllProducts({});
    assert.strictEqual(covered, false,
      'reaching the end is not the same as having read the whole catalogue');
  });

  test('every page of a small shop is actually parsed', async () => {
    const a = makeAdapter(500, 2500);
    const out = {};
    await a.fetchAllProducts(out);
    assert.strictEqual(Object.keys(out).length, 500);
  });
});

describe('the window position survives a restart', () => {
  // A deep shop needs ten sweeps to cycle. An in-memory cursor restarts at page 1 on every
  // deploy, so the shop would re-read its first ten pages forever and never reach the pages
  // the rotation exists to cover — silently undoing the whole fix. Pokemon Center lost four
  // scheduling maps to exactly this, so it is a repeat, not a hypothetical.
  const state = require('../src/core/state');

  function withFakeRedis(store) {
    const orig = state.getRedis;
    state.getRedis = () => ({
      get: async (k) => (k in store ? store[k] : null),
      set: async (k, v) => { store[k] = v; },
    });
    return () => { state.getRedis = orig; };
  }

  test('the cursor is written after a sweep and read back by a fresh instance', async () => {
    const store = {};
    const restore = withFakeRedis(store);
    try {
      const a = makeAdapter(13750, 14000);
      a._cursorLoaded = false; delete a._saveSweepCursor;
      await a.fetchAllProducts({});
      assert.strictEqual(store['tcg:sweepcursor:testshop'], '11',
        'the next window position must be persisted');

      // A new instance stands in for the process after a deploy.
      const b = makeAdapter(13750, 14000);
      b._cursorLoaded = false; delete b._saveSweepCursor;
      b.requested = [];
      await b.fetchAllProducts({});
      assert.strictEqual(b.requested[0], 11,
        'a restart must resume where the rotation left off, not restart at page 1');
    } finally { restore(); }
  });

  test('a Redis failure costs one redundant sweep, never the poll', async () => {
    const orig = state.getRedis;
    state.getRedis = () => ({
      get: async () => { throw new Error('redis down'); },
      set: async () => { throw new Error('redis down'); },
    });
    try {
      const a = makeAdapter(13750, 14000);
      a._cursorLoaded = false; delete a._saveSweepCursor;
      const out = {};
      await assert.doesNotReject(() => a.fetchAllProducts(out));
      assert.ok(Object.keys(out).length > 0, 'the sweep still returns products');
    } finally { state.getRedis = orig; }
  });
});
