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
  a._handlesLoaded = true;   // no Redis in unit tests
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

  test('the sequential explorer wraps once it reaches the end', async () => {
    // The explorer moves one page per sweep and is what guarantees a page that has only ever
    // been empty is re-checked eventually. Discovery fills the rest of the budget, so the
    // catalogue is still mapped quickly — that is asserted in the test above.
    const a = makeAdapter(1000, 1000);      // exactly 4 pages
    // One page per sweep: after four sweeps the explorer has walked 1,2,3,4 and wrapped.
    for (let sweep = 0; sweep < 4; sweep++) await a.fetchAllProducts({});
    a.requested = [];
    await a.fetchAllProducts({});
    assert.strictEqual(a.requested[0], 1, 'the explorer returns to page 1 after the end');
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
      // The record carries the handle index alongside the cursor, so keyword search can start
      // straight after a deploy instead of waiting for a sweep to rebuild it.
      const saved = JSON.parse(store['tcg:sweepcursor:testshop']);
      assert.strictEqual(saved.cursor, 2, 'the explorer advanced one page');
      assert.ok('handles' in saved, 'the handle index travels with it');
      assert.ok(Object.keys(saved.yield || {}).length > 0,
        'which pages hold product must survive a deploy, or the sweep relearns the catalogue');

      // A new instance stands in for the process after a deploy.
      const b = makeAdapter(13750, 14000);
      b._cursorLoaded = false; delete b._saveSweepCursor;
      b.requested = [];
      await b.fetchAllProducts({});
      assert.strictEqual(b.requested[0], 2,
        'a restart resumes where the explorer left off, not at page 1');
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

describe('a shop that pushes back is backed off, not hammered', () => {
  // Rotating into never-read pages replaced cheap 304s with full 250-product responses. Same
  // request COUNT, far more work for the origin — admin 429 alerts went from 1 a day to 38,
  // with Infinity Cards and Hobbiesville worst hit. Fewer pages per sweep is the lever that
  // actually reduces that load.
  const rateLimited = () => Object.assign(new Error('Rate limited (429): https://x/products.json'), {});

  function makeThrottling(failFromPage) {
    const a = makeAdapter(13750, 14000);
    a.requested = [];
    a._fetchPage = async (url) => {
      const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
      a.requested.push(page);
      if (page >= failFromPage) throw rateLimited();
      return { products: Array.from({ length: 250 }, (_, i) => ({
        id: page * 1000 + i, title: `Pokemon TCG Booster Bundle ${page}-${i}`, handle: `h${page}${i}`,
        product_type: 'TCG', tags: [], variants: [{ id: 1, price: '9.99', available: true }],
      })) };
    };
    return a;
  }

  test('the window narrows when the shop returns 429', async () => {
    const a = makeThrottling(4);
    assert.strictEqual(a._sweepPages, 10);
    await a.fetchAllProducts({});
    assert.strictEqual(a._sweepPages, 5, 'the window should halve');
  });

  test('a 429 does not throw — a deep page being busy must not fail the whole poll', async () => {
    const a = makeThrottling(4);
    const out = {};
    await assert.doesNotReject(() => a.fetchAllProducts(out));
    assert.ok(Object.keys(out).length > 0, 'pages read before the 429 are still returned');
  });

  test('the cursor stays on the page that failed, so nothing is skipped', async () => {
    const a = makeThrottling(4);
    await a.fetchAllProducts({});
    assert.strictEqual(a._sweepCursor, 4,
      'advancing past a page we never read would hide its products forever');
  });

  test('it never narrows below the floor, so rotation still progresses', async () => {
    const a = makeThrottling(1);          // every page refused
    for (let i = 0; i < 8; i++) await a.fetchAllProducts({});
    assert.strictEqual(a._sweepPages, 2);
  });

  test('a clean sweep widens the window back toward full speed', async () => {
    const a = makeThrottling(4);
    await a.fetchAllProducts({});
    assert.strictEqual(a._sweepPages, 5);
    // Shop recovers.
    a._fetchPage = async (url) => {
      const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
      return { products: Array.from({ length: 250 }, (_, i) => ({
        id: page * 1000 + i, title: `Pokemon TCG Booster Bundle ${page}-${i}`, handle: `q${page}${i}`,
        product_type: 'TCG', tags: [], variants: [{ id: 1, price: '9.99', available: true }],
      })) };
    };
    await a.fetchAllProducts({});
    assert.strictEqual(a._sweepPages, 6, 'one page earned back per clean run');
  });

  test('a non-429 error still propagates — only throttling is absorbed', async () => {
    const a = makeAdapter(13750, 14000);
    a._fetchPage = async () => { throw new Error('DNS explosion'); };
    await assert.rejects(() => a.fetchAllProducts({}), /DNS explosion/);
  });
});

describe('page 1 stays the freshness anchor', () => {
  // If a deep window is throttled and returns nothing, poll-adapter merges the cache forward
  // and the poll looks healthy — a shop could refuse us for hours while still reporting fine.
  // Falling back to page 1 keeps at least one page genuinely fresh.
  function makeDeepThrottled(page1Works) {
    const a = makeAdapter(13750, 14000);
    a._sweepCursor = 21;
    a.requested = [];
    a._fetchPage = async (url) => {
      const page = Number((url.match(/[?&]page=(\d+)/) || [])[1] || 1);
      a.requested.push(page);
      if (page === 1) {
        if (!page1Works) throw new Error('Rate limited (429): https://x/products.json');
        return { products: [{ id: 1, title: 'Pokemon TCG Booster Bundle', handle: 'h1',
          product_type: 'TCG', tags: [], variants: [{ id: 1, price: '9.99', available: true }] }] };
      }
      throw new Error('Rate limited (429): https://x/products.json');
    };
    return a;
  }

  test('a throttled deep window still returns fresh page-1 data', async () => {
    const a = makeDeepThrottled(true);
    const out = {};
    await a.fetchAllProducts(out);
    assert.ok(a.requested.includes(1), 'page 1 must be read as the fallback');
    assert.strictEqual(Object.keys(out).length, 1, 'and its products returned');
  });

  test('the cursor still holds the deep page for the next attempt', async () => {
    const a = makeDeepThrottled(true);
    await a.fetchAllProducts({});
    assert.strictEqual(a._sweepCursor, 21);
  });

  test('if page 1 is refused too, the shop really is down and it propagates', async () => {
    const a = makeDeepThrottled(false);
    await assert.rejects(() => a.fetchAllProducts({}), /rate limited/i);
  });
});

describe('the older bare-number cursor still loads', () => {
  // A running deployment has the old format in Redis. Refusing to read it would silently
  // restart every shop's rotation at page 1 on the deploy that changes the format.
  const state = require('../src/core/state');

  test('a legacy value is accepted', async () => {
    const orig = state.getRedis;
    state.getRedis = () => ({ get: async () => '37', set: async () => {} });
    try {
      const a = makeAdapter(13750, 14000);
      a._cursorLoaded = false;
      await a._loadSweepCursor();
      assert.strictEqual(a._sweepCursor, 37);
    } finally { state.getRedis = orig; }
  });
});

describe('the sweep spends its budget where the product is', () => {
  // Hobbiesville's Mega Set 7 Booster Box read in-stock for over an hour after the shop sold
  // out. Nothing was broken: the fast poll reads page 1, search only refreshes the ten
  // products a query surfaces, and a blind rotation gave page 40 the same priority as the
  // pages holding everything we track. Prioritising by yield is what closes that.

  test('once mapped, the budget goes to pages that held product', async () => {
    const a = makeAdapter(13750, 14000);
    // Pretend the catalogue is mapped: pages 3 and 7 hold product, everything else is empty.
    for (let p = 1; p <= 55; p++) a._pageYield.set(String(p), { n: 0, at: 1000 });
    a._pageYield.set('3', { n: 12, at: 1000 });
    a._pageYield.set('7', { n: 5, at: 1000 });
    a._sweepCursor = 20;

    a.requested = [];
    await a.fetchAllProducts({});
    assert.ok(a.requested.includes(3), 'a productive page must be re-read');
    assert.ok(a.requested.includes(7), 'and so must the other one');
    assert.ok(a.requested.includes(20), 'the explorer still gets its slot');
  });

  test('unread pages still take priority while the shop is being mapped', async () => {
    const a = makeAdapter(13750, 14000);
    a._pageYield.set('3', { n: 12, at: 1000 });   // one page known, the rest unread
    a.requested = [];
    await a.fetchAllProducts({});
    const unread = a.requested.filter((p) => p !== 3);
    assert.ok(unread.length >= 8, 'discovery must not stall behind a single known page');
  });

  test('a page that stops yielding is dropped from the priority set', async () => {
    const a = makeAdapter(0, 14000);              // every page comes back empty
    a._pageYield.set('3', { n: 12, at: 1000 });
    a._sweepCursor = 3;
    await a.fetchAllProducts({});
    assert.strictEqual(a._pageYield.get('3').n, 0, 'yield is re-measured, not assumed');
  });
});
