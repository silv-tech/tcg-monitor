/**
 * The hot lane — the ASINs that actually restock, polled fast enough to catch them.
 *
 * WHY IT EXISTS. Measured against production on 2026-09-28: B0H77VZBX4 restocked at 14:25:09,
 * 15:29:47 and 15:37:39 — three times in 72 minutes — and every window lasted UNDER 65 SECONDS.
 * At 15:29 we checked it 22 seconds BEFORE the restock, read out of stock, and did not look again
 * for 107 seconds, by which time it was over. Nothing was broken. Every lane was simply slower
 * than the thing it was watching:
 *
 *   - free search-tile lane, ~6s : cannot see these ASINs at all (Amazon drops an offerless ASIN
 *     from /s, and the index lags the live offer even during a restock)
 *   - browser bridge, ~119s      : straddles the window
 *   - paid round-robin, ~192s    : straddles the window
 *
 * WHY IT IS SEPARATE. The ordinary priority lane shares one tick across all 24 ASINs, so running
 * it fast enough for these would make it fast for every one of them at five times the affordable
 * cost. This lane aims a small, fast, capped budget at a handful.
 *
 * THE COST IS REAL. amazon.ca bills 5 credits per request — measured against the account counter,
 * and it matches ScraperAPI's published Amazon rate. 3 ASINs at 20s is ~1.94M credits/month.
 * Running the account dry silences EVERY lane, which is far worse than this one being slow, which
 * is why the cap here is a hard stop rather than a pacing hint.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const AmazonAdapter = require('../src/adapters/amazon');

const HOT = 'B0HOTTEST01';
const WARM = 'B0WARMER001';
const COLD = 'B0COLDEST01';
const SIGHTED = 'B0SIGHTED01';

function adapter() {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
    intervalMs: 6000, proxyTier: 'none',
    priorityAsins: [COLD, HOT, WARM, SIGHTED],
  });
  [COLD, HOT, WARM].forEach(x => a._knownProducts.set(x, { sku: x, _stockUnobserved: true }));
  a._knownProducts.set(SIGHTED, { sku: SIGHTED, inStock: false });
  a._lastInStockAt.set(HOT, Date.now());
  a._lastInStockAt.set(WARM, Date.now() - 60 * 60 * 1000);
  // COLD has never been seen in stock.

  // Record what the lane would spend a credit on, without spending one.
  a._checked = [];
  a._checkOnePriority = async (asin, _p, _now, source) => { a._checked.push({ asin, source }); return true; };
  return a;
}

describe('the hot lane spends where the restocks are', () => {
  test('it polls the hottest BLIND ASINs first', async () => {
    const a = adapter();
    await a._runHotLane({});
    assert.deepStrictEqual(a._checked.map(c => c.asin), [HOT]);
    assert.strictEqual(a._checked[0].source, 'hot', 'the source must be distinguishable in logs');
  });

  test('a SIGHTED ASIN never enters the lane, however hot', async () => {
    // It is already read every ~6s by the free tile lane, so 5 credits buys nothing. "Hot" without
    // "blind" would aim the most expensive lane at the best-covered ASINs.
    const a = adapter();
    a._lastInStockAt.set(SIGHTED, Date.now() + 10000);   // hotter than anything else
    for (let i = 0; i < 6; i++) { a._hotCheckedAt.clear(); await a._runHotLane({}); }
    assert.ok(!a._checked.some(c => c.asin === SIGHTED));
  });

  test('it does NOT re-poll an ASIN before its interval is up', async () => {
    // This is what holds the spend to HOT_COUNT/interval no matter how often the poll loop runs.
    const a = adapter();
    await a._runHotLane({});
    const first = a._checked.length;
    await a._runHotLane({});
    await a._runHotLane({});
    const extra = a._checked.slice(first).filter(c => c.asin === HOT).length;
    assert.strictEqual(extra, 0, 'the hottest ASIN must not be polled twice inside one interval');
  });

  test('it rotates across the hot set rather than fixating on one', async () => {
    const a = adapter();
    for (let i = 0; i < 3; i++) await a._runHotLane({});
    const seen = new Set(a._checked.map(c => c.asin));
    assert.ok(seen.has(HOT) && seen.has(WARM), 'every hot ASIN must come round');
  });

  test('once the interval passes, the same ASIN is polled again', async () => {
    const a = adapter();
    await a._runHotLane({});
    // The others must look FRESH, or they are more overdue than HOT and rightly go first — an
    // ASIN never checked has infinite age. That ordering is the lane working, not a bug.
    const now = Date.now();
    a._hotCheckedAt.set(WARM, now);
    a._hotCheckedAt.set(COLD, now);
    a._hotCheckedAt.set(HOT, now - 10 * 60 * 1000);
    await a._runHotLane({});
    assert.ok(a._checked.filter(c => c.asin === HOT).length >= 2);
  });

  test('THE DAILY CAP IS A HARD STOP', async () => {
    // Running the ScraperAPI account dry silences every lane, not just this one. A cap that only
    // paced would let one expensive lane take the whole system down.
    const a = adapter();
    // The day must match, or the rollover reset clears the counter before the cap is consulted —
    // which is correct behaviour and is pinned by the next test.
    a._hotDay = new Date().toISOString().slice(0, 10);
    a._hotToday = 999999;
    await a._runHotLane({});
    assert.strictEqual(a._checked.length, 0, 'no spend past the cap');
  });

  test('the cap resets on a new UTC day', async () => {
    const a = adapter();
    a._hotDay = '1999-01-01';
    a._hotToday = 999999;
    await a._runHotLane({});
    assert.ok(a._checked.length > 0, 'a new day must release the lane');
  });

  test('nothing blind means nothing spent', async () => {
    // Every ASIN visible to the free lane: this one should be silent, not fall back to spending.
    const a = adapter();
    [COLD, HOT, WARM].forEach(x => a._knownProducts.set(x, { sku: x, inStock: false }));
    await a._runHotLane({});
    assert.strictEqual(a._checked.length, 0);
  });

  test('an empty priority list is not an error', async () => {
    const a = new AmazonAdapter({
      id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
      intervalMs: 6000, proxyTier: 'none', priorityAsins: [],
    });
    await a._runHotLane({});   // must not throw
  });

  test('an ASIN never seen in stock still qualifies when there is room', async () => {
    // A freshly added watchlist ASIN has no history, and the client just added it for a reason.
    const a = adapter();
    for (let i = 0; i < 3; i++) await a._runHotLane({});
    assert.ok(a._checked.some(c => c.asin === COLD), 'HOT_COUNT is 3 and there are 3 blind ASINs');
  });
});
