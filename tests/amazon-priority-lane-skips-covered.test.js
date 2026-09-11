/**
 * The paid priority lane must spend its call where it is the ONLY signal.
 *
 * MEASURED 2026-09-12 on the live service: of the 24 priority ASINs, 11 were refreshed by the FREE
 * tile lane inside 45 seconds (ages 7-31s) and 13 had no tile at all (ages up to 573s). The paid
 * lane round-robined all 24 blindly, so ~46% of its slots re-read ASINs already in hand, while the
 * 13 that had no other signal — the entire 30th Celebration set the client hand-picked — waited a
 * full lap (571s p50, 578s worst) for their only stock check.
 *
 * That paid call buys almost nothing on a covered ASIN: the stock reading is already there, and the
 * pinned price it returns is overwritten by the next free tile within ~6s, which is why none of the
 * tile-covered priority ASINs ever hold _pricePinned.
 *
 * THE TRAP THIS AVOIDS, and it is the same one that makes _runOffersLane unable to reach 88
 * stock-blind rows: "covered" cannot mean "lastSeen moved". A price-less tile refreshes lastSeen
 * while asserting NOTHING about stock. Four of those 11 were exactly that shape. Skipping on
 * lastSeen alone would starve the rows most in need of a real read.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');

const FRESH = 5_000;      // inside PRIORITY_FREE_COVER_MS (60s)
const STALE = 400_000;

const makeAdapter = (asins) => {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000,
    priorityAsins: asins,
    timing: { priorityOffersIntervalMs: 0 },   // never rate-limit inside a test
  });
  a._lastPriorityOffersAt = 0;
  a._burstActive = () => false;
  return a;
};

/** Seed a catalogue row. observed=true means a real read; false means a price-less tile. */
const seed = (a, asin, { ageMs, observed }) => {
  a._knownProducts.set(asin, {
    sku: asin, name: 'Pokemon TCG Elite Trainer Box', price: 50, inStock: true,
    category: 'pokemon', lastSeen: Date.now() - ageMs,
    ...(observed ? {} : { _stockUnobserved: true }),
  });
};

/** Run the lane once and report which ASIN it chose to spend on. */
const pickOne = async (a) => {
  let picked = null;
  a._checkOnePriority = async (target) => { picked = target; return true; };
  a._lastPriorityOffersAt = 0;
  await a._runPriorityOffersLane({});
  return picked;
};

describe('the paid priority lane skips ASINs the free lane already covers', () => {
  test('a freshly OBSERVED ASIN is skipped in favour of a stale one', async () => {
    const a = makeAdapter(['B0COVERED1', 'B0STALE0001']);
    seed(a, 'B0COVERED1', { ageMs: FRESH, observed: true });
    seed(a, 'B0STALE0001', { ageMs: STALE, observed: true });

    assert.strictEqual(await pickOne(a), 'B0STALE0001',
      'the call belongs to the ASIN with no other signal');
  });

  test('a fresh but STOCK-BLIND ASIN is NOT skipped — lastSeen alone is not coverage', async () => {
    // The trap: a price-less tile moved lastSeen 5s ago but observed no stock. This ASIN still
    // needs the paid read, and skipping it would starve exactly the rows that need it most.
    const a = makeAdapter(['B0BLIND0001']);
    seed(a, 'B0BLIND0001', { ageMs: FRESH, observed: false });

    assert.strictEqual(await pickOne(a), 'B0BLIND0001',
      'a fresh timestamp with no stock observation is not coverage');
  });

  test('with every ASIN covered, no paid call is made at all', async () => {
    const a = makeAdapter(['B0A0000001', 'B0A0000002']);
    seed(a, 'B0A0000001', { ageMs: FRESH, observed: true });
    seed(a, 'B0A0000002', { ageMs: FRESH, observed: true });

    assert.strictEqual(await pickOne(a), null, 'spending nothing is the right answer');
  });

  test('an ASIN with no catalogue row at all is still eligible', async () => {
    const a = makeAdapter(['B0UNKNOWN1']);
    assert.strictEqual(await pickOne(a), 'B0UNKNOWN1',
      'never seen is the strongest case for a paid read');
  });

  test('coverage expires — a formerly covered ASIN comes back into rotation', async () => {
    const a = makeAdapter(['B0EXPIRED1']);
    seed(a, 'B0EXPIRED1', { ageMs: 90_000, observed: true });   // older than the 60s window
    assert.strictEqual(await pickOne(a), 'B0EXPIRED1',
      'if Amazon drops the tile, the paid lane must pick the ASIN back up');
  });

  test('THE MEASURED SHAPE: 7 covered + 13 uncovered — the budget goes to the 13', async () => {
    // Mirrors the live classification: 11 tile-refreshed, of which 4 were stock-blind, so 7 are
    // genuinely skippable and 17 remain eligible.
    const covered = Array.from({ length: 7 }, (_, i) => `B0COV${String(i).padStart(5, '0')}`);
    const blind = Array.from({ length: 4 }, (_, i) => `B0BLD${String(i).padStart(5, '0')}`);
    const uncovered = Array.from({ length: 13 }, (_, i) => `B0UNC${String(i).padStart(5, '0')}`);

    const a = makeAdapter([...covered, ...blind, ...uncovered]);
    for (const s of covered) seed(a, s, { ageMs: FRESH, observed: true });
    for (const s of blind) seed(a, s, { ageMs: FRESH, observed: false });
    for (const s of uncovered) seed(a, s, { ageMs: STALE, observed: true });

    const picks = [];
    for (let i = 0; i < 17; i++) picks.push(await pickOne(a));

    assert.ok(!picks.some((p) => covered.includes(p)),
      'not one call should go to an ASIN whose stock was just observed for free');
    const distinct = new Set(picks);
    assert.strictEqual(distinct.size, 17,
      'a full lap now covers 17 ASINs instead of 24 — the same budget, ~29% shorter');
    for (const s of [...blind, ...uncovered]) {
      assert.ok(distinct.has(s), `${s} must still be served`);
    }
  });

  test('the cursor still advances, so no ASIN is starved across laps', async () => {
    const a = makeAdapter(['B0R0000001', 'B0R0000002', 'B0R0000003']);
    for (const s of ['B0R0000001', 'B0R0000002', 'B0R0000003']) seed(a, s, { ageMs: STALE, observed: true });

    const picks = [await pickOne(a), await pickOne(a), await pickOne(a)];
    assert.strictEqual(new Set(picks).size, 3, 'round-robin still reaches everything');
  });
});
