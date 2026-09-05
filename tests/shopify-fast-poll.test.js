/**
 * Shopify fast-poll path.
 *
 * These shops carry 11,000-19,000 products, so a full sweep is ten paged requests. Running
 * that every 8 seconds put ~1.25 req/sec on a single store and ~39 req/sec in aggregate,
 * which rate-limited every shop into a circuit-broken outage on 2026-09-05.
 *
 * It was also unnecessary: /products.json is ordered by published_at DESCENDING (verified
 * live against hobbiesville, 401games, facetoface and kanzengames), so every newly published
 * product is on page 1. A normal poll now reads that one page; the whole catalogue is swept
 * on a slow cadence for stock and price accuracy.
 *
 * The risk this introduces is that a partial read looks like products disappearing. These
 * tests exist mostly to pin that down.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const ShopifyAdapter = require('../src/adapters/shopify');
const { FULL_SWEEP_MS } = ShopifyAdapter;

function makeAdapter(overrides = {}) {
  return new ShopifyAdapter({
    id: 'testshop',
    name: 'Test Shop',
    url: 'https://testshop.example',
    type: 'shopify',
    intervalMs: 8000,
    searchKeywords: [],
    collections: [],
    ...overrides,
  });
}

function product(id, title, price, available = true) {
  return {
    id,
    title,
    handle: `h-${id}`,
    product_type: 'Trading Cards',
    tags: [],
    variants: [{ id: id * 10, price: String(price), available, title: 'Default' }],
    images: [],
  };
}

describe('shopify fast poll: sweep scheduling', () => {
  test('the first poll after boot is FAST, not a sweep', () => {
    // 31 shops each booting into a 10-page sweep is ~310 requests in the first seconds of a
    // deploy — the same ~39 req/sec burst that caused the outage, recreated on every restart.
    // Only a shop whose offset happens to be 0 may sweep immediately.
    const a = makeAdapter({ id: 'hobbiesville' });
    a._isFullSweepDue();
    assert.ok(a._sweepOffset > 0, 'this fixture should have a non-zero offset');

    const b = makeAdapter({ id: 'hobbiesville' });
    assert.strictEqual(b._isFullSweepDue(), false, 'first poll must not be a full sweep');
  });

  test('the first sweep lands at boot + this shop\'s own offset', () => {
    const now = Date.now();
    const a = makeAdapter({ id: 'hobbiesville' });
    a._isFullSweepDue(now);
    const dueAt = a._lastFullSweep + FULL_SWEEP_MS;
    assert.ok(dueAt >= now, 'not already due');
    assert.ok(dueAt <= now + FULL_SWEEP_MS, 'due within one window');
    assert.strictEqual(a._isFullSweepDue(dueAt), true, 'sweeps once the offset elapses');
  });

  test('initial sweeps spread across the window rather than clustering', () => {
    const ids = ['hobbiesville', '401games', 'facetoface', 'kanzengames', 'chimeragaming',
      'untouchables', 'zardocards', 'rivalcards', 'tcgfy', 'spshop'];
    const now = Date.now();
    const dueTimes = ids.map((id) => {
      const a = makeAdapter({ id });
      a._isFullSweepDue(now);
      return a._lastFullSweep + FULL_SWEEP_MS - now;
    });
    assert.strictEqual(new Set(dueTimes).size, ids.length, 'no two shops sweep at the same moment');
    assert.ok(Math.max(...dueTimes) - Math.min(...dueTimes) > 60000, 'genuinely spread out');
  });

  test('a poll straight after a sweep is fast, not another sweep', () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();
    assert.strictEqual(a._isFullSweepDue(), false);
  });

  test('a sweep comes due again once the window has passed', () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000;
    assert.strictEqual(a._isFullSweepDue(), true);
  });

  test('sweep offsets differ per shop so all 31 do not sweep on one tick', () => {
    const ids = ['hobbiesville', '401games', 'facetoface', 'kanzengames', 'chimeragaming',
      'untouchables', 'zardocards', 'rivalcards', 'tcgfy', 'spshop'];
    const offsets = ids.map((id) => {
      const a = makeAdapter({ id });
      a._isFullSweepDue();
      return a._sweepOffset;
    });
    assert.strictEqual(new Set(offsets).size, ids.length, 'every shop gets its own offset');
  });

  test('the offset is deterministic — the same shop always lands on the same slot', () => {
    const one = makeAdapter({ id: 'hobbiesville' });
    const two = makeAdapter({ id: 'hobbiesville' });
    one._isFullSweepDue();
    two._isFullSweepDue();
    assert.strictEqual(one._sweepOffset, two._sweepOffset);
  });
});

describe('shopify fast poll: reads only page 1', () => {
  test('a fast poll makes exactly ONE request', async () => {
    const a = makeAdapter();
    a._lastFullSweep = Date.now();
    a._sweepOffset = 0;

    const urls = [];
    a._fetchPage = async (url) => {
      urls.push(url);
      return { products: [product(1, 'Booster Box', '49.99')], changed: true };
    };

    const products = await a.fetchProducts();
    assert.strictEqual(urls.length, 1, 'ten paged requests became one');
    assert.match(urls[0], /page=1/);
    assert.strictEqual(a._partialPoll, true, 'and it declares itself partial');
    assert.strictEqual(Object.keys(products).length, 1);
  });

  test('a full sweep pages through and is NOT marked partial', async () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000; // force a sweep
    let page = 0;
    a._fetchPage = async () => {
      page += 1;
      // Two full pages then a short one ends the walk.
      if (page > 2) return { products: [product(999, 'Last', '1.00')], changed: true };
      const list = [];
      for (let i = 0; i < a.pageLimit; i++) list.push(product(page * 1000 + i, `P${i}`, '9.99'));
      return { products: list, changed: true };
    };

    await a.fetchProducts();
    assert.ok(page >= 3, 'walked multiple pages');
    assert.strictEqual(a._partialPoll, false, 'a complete read is not partial');
  });

  test('a throttled fast poll fails the poll rather than reporting an empty shop', async () => {
    const a = makeAdapter();
    a._lastFullSweep = Date.now();
    a._sweepOffset = 0;
    a._fetchPage = async () => { throw new Error('Rate limited (429): https://testshop.example/products.json'); };
    await assert.rejects(() => a.fetchProducts(), /rate limited/i);
  });

  test('a non-throttle failure falls back to a full sweep instead of losing the poll', async () => {
    const a = makeAdapter();
    a._lastFullSweep = Date.now();
    a._sweepOffset = 0;
    let calls = 0;
    a._fetchPage = async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return { products: [product(7, 'Elite Trainer Box', '59.99')], changed: true };
    };
    const products = await a.fetchProducts();
    assert.strictEqual(a._partialPoll, false, 'fallback produced a complete read');
    assert.strictEqual(Object.keys(products).length, 1);
  });

  test('keyword filtering still applies on the fast path', async () => {
    const a = makeAdapter({ searchKeywords: ['pokemon'] });
    a._lastFullSweep = Date.now();
    a._sweepOffset = 0;
    a._fetchPage = async () => ({
      products: [product(1, 'Pokemon Booster Box', '49.99'), product(2, 'Magic Bundle', '39.99')],
      changed: true,
    });
    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 1, 'only the matching product is kept');
  });
});

describe('shopify fast poll: a partial read never loses stock', () => {
  // This is the merge in poll-adapter.js. A partial poll must overlay the cached catalogue,
  // never replace it — otherwise every product off page 1 looks like it vanished.
  const merge = (adapter, oldProducts, newProducts) => (
    adapter._partialPoll && Object.keys(oldProducts).length > 0
      ? { ...oldProducts, ...newProducts }
      : newProducts
  );

  test('products off page 1 survive a partial poll', () => {
    const a = makeAdapter();
    a._partialPoll = true;
    const cached = { s1: { sku: 's1', inStock: true }, s2: { sku: 's2', inStock: true } };
    const fresh = { s1: { sku: 's1', inStock: false } };
    const merged = merge(a, cached, fresh);
    assert.strictEqual(Object.keys(merged).length, 2, 's2 is not lost');
    assert.strictEqual(merged.s1.inStock, false, 'fresh data still wins for what WAS read');
    assert.strictEqual(merged.s2.inStock, true, 'unread product keeps its known state');
  });

  test('a small shop is safe — the count heuristic alone would have failed here', () => {
    // 300 cached, 250 on page 1. 250 is NOT < 30% of 300, so the old partial-result
    // heuristic would have called this complete and marked 50 real products out of stock.
    const a = makeAdapter();
    a._partialPoll = true;
    const cached = {};
    for (let i = 0; i < 300; i++) cached[`s${i}`] = { sku: `s${i}`, inStock: true };
    const fresh = {};
    for (let i = 0; i < 250; i++) fresh[`s${i}`] = { sku: `s${i}`, inStock: true };

    assert.ok(!(250 < 300 * 0.3), 'confirms the heuristic would NOT have caught this');
    const merged = merge(a, cached, fresh);
    assert.strictEqual(Object.keys(merged).length, 300, 'no product is dropped');
  });

  test('a full sweep still replaces, so genuinely delisted products are cleaned up', () => {
    const a = makeAdapter();
    a._partialPoll = false;
    const cached = { s1: {}, s2: {} };
    const fresh = { s1: {} };
    const merged = merge(a, cached, fresh);
    assert.strictEqual(Object.keys(merged).length, 1, 's2 is correctly seen as gone');
  });

  test('a partial first poll cannot wipe an empty cache into existence', () => {
    const a = makeAdapter();
    a._partialPoll = true;
    const merged = merge(a, {}, { s1: {} });
    assert.deepStrictEqual(Object.keys(merged), ['s1']);
  });
});

describe('shopify fast poll: asks for a small page, not the whole one', () => {
  // The budget caps how many REQUESTS we make, not how big they are. A 250-product page is
  // A restock can be anywhere in a catalogue, not only at the top. At limit=50 the fast poll
  // saw 131 of facetoface's 1,581 SKUs — 92% of the shop went unchecked between sweeps, and
  // every change accumulated in that window fired at once when the sweep landed.
  test('a fast poll requests a full page, for restock coverage', async () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();
    let url = '';
    a._fetchPage = async (u) => { url = u; return { products: [], changed: true }; };
    await a.fetchProducts();
    assert.match(url, /limit=250\b/, 'fast poll reads a full page — same request, 5x the SKUs');
  });

  test('a fast poll is still ONE request — coverage came from page size, not more requests', async () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();
    const urls = [];
    a._fetchPage = async (u) => { urls.push(u); return { products: [], changed: true }; };
    await a.fetchProducts();
    assert.strictEqual(urls.length, 1, 'still one request per fast poll');
    assert.match(urls[0], /page=1\b/);
  });

  test('a full sweep still walks every page', async () => {
    const a = makeAdapter();
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000;
    const urls = [];
    let page = 0;
    a._fetchPage = async (u) => {
      urls.push(u);
      page += 1;
      if (page > 2) return { products: [product(999, 'Last', '1.00')], changed: true };
      const list = [];
      for (let i = 0; i < a.pageLimit; i++) list.push(product(page * 1000 + i, `P${i}`, '9.99'));
      return { products: list, changed: true };
    };
    await a.fetchProducts();
    assert.ok(urls.length >= 3, 'the sweep pages past page 1');
    assert.match(urls[0], /limit=250\b/);
  });

  test('collection shops fetch a full page per collection on the fast path', async () => {
    const a = makeAdapter({ collections: ['pokemon-sealed'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();
    let url = '';
    a._fetchPage = async (u) => { url = u; return { products: [], changed: true }; };
    await a.fetchProducts();
    assert.match(url, /collections\/pokemon-sealed\/products\.json\?limit=250/);
  });

});

describe('shopify fast poll: collection shops fetch in parallel', () => {
  test('both collections are in flight at once, not end to end', async () => {
    // Sequential fetching was the ONLY reason Untouchables (10.2s) and Chimera Gaming (10.3s)
    // missed the 10s target while every single-request shop sat under 9.6s.
    const a = makeAdapter({ collections: ['pokemon-sealed', 'pokemon-new-releases'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();

    let inFlight = 0;
    let maxInFlight = 0;
    a._fetchPage = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return { products: [], changed: true };
    };

    const t = Date.now();
    await a.fetchProducts();
    const elapsed = Date.now() - t;

    assert.strictEqual(maxInFlight, 2, 'both collections should be in flight together');
    assert.ok(elapsed < 55, `expected ~30ms not ~60ms, got ${elapsed}ms`);
  });

  test('every collection still contributes its products', async () => {
    const a = makeAdapter({ collections: ['c1', 'c2'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();
    let n = 0;
    a._fetchPage = async () => {
      n += 1;
      return { products: [product(n, `Booster Box ${n}`, '49.99')], changed: true };
    };
    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 2, 'no collection is dropped');
  });

  test('one failing collection still fails the poll rather than half-reporting', async () => {
    const a = makeAdapter({ collections: ['c1', 'c2'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now();
    a._fetchPage = async (url) => {
      if (url.includes('c2')) throw new Error('Rate limited (429): c2');
      return { products: [product(1, 'Booster Box', '49.99')], changed: true };
    };
    await assert.rejects(() => a.fetchProducts(), /rate limited/i);
  });
});

describe('shopify: a partly-failed sweep must not fake out-of-stock', () => {
  /**
   * The facetoface alert flood, 2026-09-05 19:55.
   *
   * A shop with two collections lost one to a 429. The other returned 81 of its 131 products,
   * so the empty-result guard did not fire and poll-adapter's count heuristic ("new < 30% of
   * old") read 81-of-131 as a COMPLETE read. Stale cleanup then marked the missing
   * collection's ~50 products out of stock, and the next successful sweep reported all of them
   * coming back: 13 RESTOCK alerts in 0s for products that never left the shelf.
   */
  test('one failed collection marks the sweep partial', async () => {
    const a = makeAdapter({ collections: ['pokemon-sealed', 'pokemon-new-releases'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000; // force a sweep

    a.fetchCollection = async (handle, products) => {
      if (handle === 'pokemon-sealed') throw new Error('Rate limited (429): sealed');
      products['kept-1'] = { sku: 'kept-1', inStock: true };
    };

    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 1, 'the collection that worked still counts');
    assert.strictEqual(a._partialPoll, true, 'a partly-read sweep is partial, not complete');
  });

  test('the count heuristic alone would NOT have caught it', () => {
    // 81 of 131 is the real shape of the failure. This documents why an explicit flag is
    // needed rather than relying on the ratio.
    const oldCount = 131, newCount = 81;
    assert.strictEqual(newCount < oldCount * 0.3, false, 'reads as a complete poll');
  });

  test('a fully successful sweep stays complete, so real delistings are still cleaned up', async () => {
    const a = makeAdapter({ collections: ['c1', 'c2'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000;
    a.fetchCollection = async (handle, products) => { products[handle] = { sku: handle }; };
    await a.fetchProducts();
    assert.strictEqual(a._partialPoll, false, 'nothing failed, so nothing is hidden');
  });

  test('a non-throttle failure also marks it partial', async () => {
    // A socket error leaves the catalogue just as incomplete as a 429 does.
    const a = makeAdapter({ collections: ['c1', 'c2'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000;
    a.fetchCollection = async (handle, products) => {
      if (handle === 'c1') throw new Error('socket hang up');
      products.ok = { sku: 'ok' };
    };
    await a.fetchProducts();
    assert.strictEqual(a._partialPoll, true);
  });

  test('everything failing still throws rather than reporting an empty shop', async () => {
    const a = makeAdapter({ collections: ['c1', 'c2'] });
    a._sweepOffset = 0;
    a._lastFullSweep = Date.now() - FULL_SWEEP_MS - 1000;
    a.fetchCollection = async () => { throw new Error('Rate limited (429): x'); };
    a.fetchAllProducts = async () => { throw new Error('Rate limited (429): y'); };
    await assert.rejects(() => a.fetchProducts(), /rate limited/i);
  });
});
