/**
 * Amazon fast restock tracking: an auto-hot AOD lane governed by ONE shared rate budget.
 *
 * The whole point is speed WITHOUT downtime. Every Amazon outage this monitor has had came from
 * the request rate (or a burst) crossing a measured ceiling and then a cooldown stacking on top.
 * So these tests assert the safety invariants hardest:
 *   - every AOD call passes through the shared budget with burst 1 (strictly one at a time),
 *   - a budget MISS degrades cleanly (null, cached kept, NO false-OOS, NO 10-min cooldown),
 *   - the hot lane (priority 0) is preferred over the background sweep (priority 1),
 * and then the speed behaviour: the 48h/cap-10 hot set, the sweep skipping hot ASINs, and the
 * single-flight guard that stops an orphaned sweep racing a fresh one.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const rateBudget = require('../src/utils/rate-budget');

// The sweep caches offer-listing id / seller in Redis (fire-and-forget). Stub so a bare test run
// opens no ioredis handle (which would keep Node alive and hang the process on exit).
const state = require('../src/core/state');
state.cacheOfferListingId = async () => {};
state.cacheSellerInfo = async () => {};

const CONFIG_WL = ['B0H77W4411', 'B0H77VZBX4', 'B0H7FDBNSB'];

function adapter() {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
    intervalMs: 6000, proxyTier: 'none', watchlist: CONFIG_WL,
  });
  a.reportFreshness = () => {};
  return a;
}

// Most tests replace rateBudget.acquire; restore the real one afterwards so nothing leaks.
const realAcquire = rateBudget.acquire;
afterEach(() => { rateBudget.acquire = realAcquire; rateBudget._reset(); });

describe('shared AOD budget: every AOD call is governed, burst 1, correct key', () => {
  test('_stealthCheckAsin acquires from amazon:aod with burst 1 at ~0.45 req/s before any fetch', async () => {
    const calls = [];
    rateBudget.acquire = async (name, waitMs, priority, autoCreate) => {
      calls.push({ name, waitMs, priority, autoCreate });
      return false; // deny → short-circuit before the network fetch
    };
    const a = adapter();
    const out = await a._stealthCheckAsin('B0TEST');
    assert.strictEqual(out, null, 'a denied budget returns null (no fetch)');
    assert.strictEqual(calls.length, 1, 'exactly one acquire per AOD call');
    assert.strictEqual(calls[0].name, 'amazon:aod', 'single shared budget key');
    assert.strictEqual(calls[0].autoCreate.burst, 1, 'burst 1 = strictly one AOD request at a time');
    assert.strictEqual(calls[0].autoCreate.ratePerSec, 0.45, 'rate just under the 0.5 req/s ceiling');
    assert.ok(calls[0].waitMs <= 8000, 'small max-wait so an orphaned poll cannot pile up waiters');
  });

  test('a budget MISS is not an endpoint throttle: null, cached kept, cooldown NOT triggered', async () => {
    rateBudget.acquire = async () => false;
    const a = adapter();
    a._lastFetchThrottled = true; // pretend a prior real throttle; a budget miss must clear it, not add to it
    const out = await a._stealthCheckAsin('B0TEST');
    assert.strictEqual(out, null);
    assert.strictEqual(a._lastFetchThrottled, false,
      'a budget miss must leave _lastFetchThrottled false so the 2-strike 10-min cooldown never fires');
  });

  test('the sweep treats a budget-missed ASIN as "keep cached" — never a false out-of-stock', async () => {
    rateBudget.acquire = async () => false; // every AOD denied this pass
    const a = adapter();
    a._knownProducts.set('B0COLD', { sku: 'B0COLD', name: 'Pokemon TCG Box', category: 'pokemon', price: 20, inStock: true });
    const products = {};
    await a._monitorKnownAsins(products);
    assert.deepStrictEqual(products.B0COLD, a._knownProducts.get('B0COLD'),
      'a denied check keeps the cached row unchanged (inStock stays true, no OOS event)');
  });
});

describe('rate safety: the shared budget physically caps combined AOD throughput', () => {
  test('under saturating hot+sweep demand, grants never exceed ~0.45 req/s (burst 1)', async () => {
    rateBudget.acquire = realAcquire; // use the REAL bucket with Amazon's exact config
    rateBudget._reset();
    const cfg = { ratePerSec: 0.45, burst: 1 };
    // 40 requests contend at once (hot priority 0 mixed with sweep priority 1), each willing to
    // wait up to 3s — exactly the shape of the two loops racing the one endpoint.
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => rateBudget.acquire('amazon:aod', 3000, i % 2, cfg)),
    );
    const elapsed = (Date.now() - start) / 1000;
    const granted = results.filter(Boolean).length;
    // Over the ~3s window the cap is 0.45/s * elapsed + the single burst token. Anything at or
    // below proves the endpoint can never be pushed past its measured ceiling, no matter the demand.
    const ceiling = Math.ceil(0.45 * elapsed + 1) + 1; // +1 slack for timer granularity
    assert.ok(granted <= ceiling,
      `granted ${granted} must be <= ${ceiling} over ${elapsed.toFixed(1)}s — rate is capped`);
    assert.ok(granted >= 1, 'at least the burst token is granted (the lane is not dead-locked)');
  });
});

describe('priority: the hot lane wins the shared budget over the background sweep', () => {
  test('fetchProductPage (hot) acquires at priority 0; the sweep acquires at priority 1', async () => {
    const seen = [];
    rateBudget.acquire = async (_n, _w, priority) => { seen.push(priority); return false; };
    const a = adapter();

    await a.fetchProductPage('B0H77W4411');            // hot / watchlist path
    assert.deepStrictEqual(seen, [0], 'watchlist/hot fast-poll is latency-critical → priority 0');

    seen.length = 0;
    a._knownProducts.set('B0COLD', { sku: 'B0COLD', name: 'Pokemon TCG Box', category: 'pokemon', price: 20, inStock: false });
    await a._monitorKnownAsins({});
    assert.ok(seen.length >= 1 && seen.every(p => p === 1), `sweep is background → priority 1 (saw ${seen})`);
  });
});

describe('auto-hot set: 48h window, cap 10, config always included', () => {
  test('config watchlist is always in the fast lane (unindexed — search can never rediscover it)', () => {
    const a = adapter();
    assert.deepStrictEqual([...a.getFastPollAsins()].sort(), [...CONFIG_WL].sort());
  });

  test('an ASIN in stock within 48h joins; one last in stock >48h ago does not', () => {
    const a = adapter();
    a._lastInStockAt.set('B0FRESH', Date.now() - 60 * 60 * 1000);       // 1h ago
    a._lastInStockAt.set('B0STALE', Date.now() - 49 * 60 * 60 * 1000);  // 49h ago
    const set = a.getFastPollAsins();
    assert.ok(set.has('B0FRESH'), 'seen in stock 1h ago → hot');
    assert.ok(!set.has('B0STALE'), 'last in stock 49h ago → aged out to the cold sweep');
  });

  test('the fast lane is capped at HOT_MAX, keeping the most-recently-in-stock', () => {
    const a = adapter();
    const now = Date.now();
    // 20 hot ASINs, B0H00 the most recent .. B0H19 the least recent (but all within 48h)
    for (let i = 0; i < 20; i++) a._lastInStockAt.set('B0H' + String(i).padStart(2, '0'), now - i * 1000);
    const set = a.getFastPollAsins();
    assert.strictEqual(set.size, 10, 'capped at HOT_MAX (10) total');
    // config (3) always kept + the 7 freshest auto-hot
    for (const c of CONFIG_WL) assert.ok(set.has(c), `config ${c} always kept`);
    assert.ok(set.has('B0H00') && set.has('B0H06'), 'the freshest auto-hot ASINs are kept');
    assert.ok(!set.has('B0H07') && !set.has('B0H19'), 'staler auto-hot ASINs fall to the cold sweep');
  });
});

describe('the cold sweep skips hot ASINs (no double-spend of the shared budget)', () => {
  test('an ASIN in the hot set is not AOD-checked by the sweep', async () => {
    const a = adapter();
    a._knownProducts.set('B0HOT', { sku: 'B0HOT', name: 'Pokemon TCG Box hot', category: 'pokemon', price: 20, inStock: true });
    a._knownProducts.set('B0COLD', { sku: 'B0COLD', name: 'Pokemon TCG Box cold', category: 'pokemon', price: 20, inStock: false });
    a._lastInStockAt.set('B0HOT', Date.now()); // makes B0HOT hot → fast lane owns it

    const checked = [];
    a._stealthCheckAsin = async (asin) => { checked.push(asin); a._lastFetchThrottled = false; return null; };
    await a._monitorKnownAsins({});

    assert.ok(!checked.includes('B0HOT'), 'the sweep must not re-check a hot ASIN');
    assert.ok(checked.includes('B0COLD'), 'the sweep still covers the cold long tail');
  });
});

describe('single-flight: an orphaned sweep cannot race a fresh one', () => {
  test('a second concurrent _monitorKnownAsins returns immediately without running the body', async () => {
    const a = adapter();
    let innerRuns = 0;
    a._monitorKnownAsinsInner = async () => {
      innerRuns++;
      await new Promise(r => setTimeout(r, 50));
    };
    const first = a._monitorKnownAsins({});        // takes the lock
    const second = a._monitorKnownAsins({});        // should no-op while first holds it
    await Promise.all([first, second]);
    assert.strictEqual(innerRuns, 1, 'only one sweep body runs at a time');
    assert.strictEqual(a._sweepInFlight, false, 'the guard is released after completion');
  });

  test('the guard is released even if the sweep body throws', async () => {
    const a = adapter();
    a._monitorKnownAsinsInner = async () => { throw new Error('boom'); };
    await assert.rejects(() => a._monitorKnownAsins({}), /boom/);
    assert.strictEqual(a._sweepInFlight, false, 'finally releases the guard on error');
  });
});

describe('throttle accounting is per-call (immune to sibling-lane writes) — fix A', () => {
  test('the sweep trips the 10-min cooldown from its OWN 503 even if the shared field is cleared', async () => {
    const a = adapter();
    for (let i = 0; i < 5; i++) {
      a._knownProducts.set('B0C' + i, { sku: 'B0C' + i, name: 'Pokemon TCG Box ' + i, category: 'pokemon', price: 10, inStock: false });
    }
    // Every AOD read is a genuine 503 — mirror what the real _stealthCheckAsin does on a 503
    // (signal ctx AND count the strike centrally), while a "sibling lane" simultaneously clears the
    // shared _lastFetchThrottled field — the exact race that could otherwise mask the strike.
    a._stealthCheckAsin = async (asin, priority, ctx) => {
      if (ctx) ctx.throttled = true;   // this call's real 503 (drives the sweep's break)
      a._lastFetchThrottled = false;   // sibling lane clobbers the shared field (must not matter)
      a._aodStrike();                  // centralised cooldown trip — any lane's 503 counts
      return null;
    };
    await a._monitorKnownAsins({});
    assert.ok(a._aodCooldownUntil > Date.now(),
      'two 503s must trip the cooldown despite the shared field being cleared to false');
  });
});

describe('fast-lane items cannot flap via a stale main-poll carry-forward — fix B', () => {
  test('fetchProductPage writes the fresh product back into _knownProducts', async () => {
    const a = adapter();
    a._stealthCheckAsin = async () => ({ name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 89.99, inStock: true, image: '' });
    const p = await a.fetchProductPage('B0H78BB9TY');
    assert.ok(p, 'returns the product');
    assert.strictEqual(a._knownProducts.get('B0H78BB9TY')?.inStock, true,
      '_knownProducts reflects the fresh fast-loop read, so the main poll cannot carry a stale row and diff a false OOS');
  });
});

describe('hotness is stamped only on FRESH in-stock reads, never carry-forward — fix C', () => {
  test('_buildFromSearch stamps a priced in-stock tile but not a price-unknown tile', () => {
    const a = adapter();
    a._buildFromSearch({ asin: 'B0PRICED', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 40, inStock: true, image: '', _priceUnknown: false }, 'pokemon');
    assert.ok(a._lastInStockAt.has('B0PRICED'), 'a fresh priced in-stock tile stamps hotness');

    a._buildFromSearch({ asin: 'B0UNK', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 0, inStock: false, image: '', _priceUnknown: true }, 'pokemon');
    assert.ok(!a._lastInStockAt.has('B0UNK'), 'a price-unknown tile asserts nothing about stock → no stamp');
  });
});

describe('last-in-stock stamping keeps the fast lane fed', () => {
  test('fetchProductPage stamps lastInStockAt only when the item is in stock', async () => {
    const a = adapter();
    // in stock → stamped
    a._stealthCheckAsin = async () => ({ name: 'Pokemon TCG 30th Celebration ETB', price: 40, inStock: true, image: '' });
    await a.fetchProductPage('B0INSTOCK');
    assert.ok(a._lastInStockAt.has('B0INSTOCK'), 'an in-stock watchlist read marks the ASIN hot');

    // out of stock → not stamped (hotness must decay)
    a._stealthCheckAsin = async () => ({ name: 'Pokemon TCG 30th Celebration ETB', price: 40, inStock: false, image: '' });
    await a.fetchProductPage('B0OOS');
    assert.ok(!a._lastInStockAt.has('B0OOS'), 'an out-of-stock read must not mark the ASIN hot');
  });
});
