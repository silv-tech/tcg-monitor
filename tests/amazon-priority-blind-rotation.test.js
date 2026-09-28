/**
 * The PAID priority lane must spend its slots where nothing else can see.
 *
 * THE INCIDENT THIS PINS — B0H77VZBX4, 2026-09-28 14:25:09 UTC. A real restock at $27.99 on a
 * priority ASIN. The competitor alerted; we did not. Two lanes should have caught it:
 *
 *   1. The browser bridge was in a 60-minute captcha backoff from 14:22:46 — dark.
 *   2. The paid lane round-robins the priority set flatly: 24 ASINs x 18s = 432s per ASIN. It
 *      checked B0H77VZBX4 at ~14:22 and ~14:29 and caught neither side of the window.
 *
 * The flat rotation is the part that was wasteful rather than merely unlucky. 16 of those 24 are
 * SIGHTED — the free search-tile lane reads them every ~6s — so two thirds of a scarce paid
 * budget went on ASINs we could already see. Weighting 3 ticks in 4 to the blind set takes them
 * from 432s to ~192s at IDENTICAL credit cost, and when the bridge is down they get everything
 * (~144s).
 *
 * The asymmetry that decides the defaults: over-polling a blind ASIN costs credits we have
 * budgeted; under-polling one costs a restock we cannot get back.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const AmazonAdapter = require('../src/adapters/amazon');

const BLIND = ['BL1', 'BL2', 'BL3', 'BL4', 'BL5', 'BL6', 'BL7', 'BL8'];
const SIGHTED = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

function adapter({ bridgeAgeMs = 0, blind = BLIND, sighted = SIGHTED } = {}) {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
    intervalMs: 6000, proxyTier: 'none', priorityAsins: [...blind, ...sighted],
  });
  blind.forEach(x => a._knownProducts.set(x, { sku: x, _stockUnobserved: true }));
  sighted.forEach(x => a._knownProducts.set(x, { sku: x, inStock: false }));
  a._lastBridgePushAt = bridgeAgeMs === null ? 0 : Date.now() - bridgeAgeMs;
  return a;
}

const run = (a, n) => Array.from({ length: n }, () => a._nextPriorityTarget());

describe('the paid lane favours what nothing else can see', () => {
  test('blind ASINs get 3 of every 4 slots while the bridge is healthy', () => {
    const seq = run(adapter({ bridgeAgeMs: 1000 }), 40);
    const blindHits = seq.filter(x => x.startsWith('BL')).length;
    assert.strictEqual(blindHits, 30, '3 in 4 ticks must go to the blind set');
  });

  test('every blind ASIN is reached — no starvation inside the favoured group', () => {
    const seq = run(adapter({ bridgeAgeMs: 1000 }), 40);
    for (const x of BLIND) assert.ok(seq.includes(x), `${x} never came round`);
  });

  test('sighted ASINs are not abandoned — seller and price still refresh', () => {
    // They do not need paid STOCK checks (the free tile lane reads them every ~6s) but a lane
    // that never revisits them lets seller and price drift forever.
    const seq = run(adapter({ bridgeAgeMs: 1000 }), 120);
    for (const x of SIGHTED) assert.ok(seq.includes(x), `${x} was abandoned entirely`);
  });

  test('BRIDGE DOWN: the blind set gets every single slot', () => {
    // The guarantee that a captcha can no longer open the hole B0H77VZBX4 fell through.
    const seq = run(adapter({ bridgeAgeMs: 10 * 60 * 1000 }), 40);
    assert.ok(seq.every(x => x.startsWith('BL')),
      'with no bridge, a paid slot spent on a sighted ASIN is a slot not spent on a blind one');
  });

  test('a bridge that has NEVER pushed counts as down', () => {
    // Cold start. Absence of a push is not evidence of coverage.
    const seq = run(adapter({ bridgeAgeMs: null }), 20);
    assert.ok(seq.every(x => x.startsWith('BL')));
  });

  test('a bridge silent for 2 cycles is NOT yet down', () => {
    // One missed push is normal jitter; the lane must not thrash on it.
    const seq = run(adapter({ bridgeAgeMs: 150 * 1000 }), 40);
    assert.ok(seq.some(x => x.startsWith('S')), 'a brief gap must not trigger the emergency mode');
  });

  test('with nothing blind, the rotation is exactly the old flat one', () => {
    // The unchanged path. Every ASIN, in order, once each.
    const a = adapter({ blind: [], sighted: SIGHTED, bridgeAgeMs: 1000 });
    assert.deepStrictEqual(run(a, 6), SIGHTED);
  });

  test('with everything blind, the rotation is also flat', () => {
    const a = adapter({ blind: BLIND, sighted: [], bridgeAgeMs: 1000 });
    assert.deepStrictEqual(run(a, 8), BLIND);
  });

  test('an empty priority list returns nothing rather than throwing', () => {
    const a = new AmazonAdapter({
      id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
      intervalMs: 6000, proxyTier: 'none', priorityAsins: [],
    });
    assert.strictEqual(a._nextPriorityTarget(), null);
  });

  test('a priority ASIN with no row at all counts as blind', () => {
    // A seeded watchlist ASIN nothing has read yet is the most blind thing there is.
    const a = adapter({ bridgeAgeMs: 1000 });
    a._priorityAsins.push('B0NOROWYET');
    const seq = run(a, 40);
    assert.ok(seq.includes('B0NOROWYET'));
  });
});

describe('the measured effect on B0H77VZBX4', () => {
  test('8 blind of 24 goes from 432s to ~192s at the same credit cost', () => {
    // 24 ASINs x 18s = 432s flat. Weighted: 8 blind / 0.75 of ticks x 18s = 192s. The lane fires
    // exactly as often either way — this spends nothing extra, it only stops re-reading what the
    // free lane already knows.
    const a = adapter({ bridgeAgeMs: 1000, blind: BLIND, sighted: ['S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11','S12','S13','S14','S15','S16'] });
    const seq = run(a, 400);
    const gaps = [];
    let last = -1;
    seq.forEach((x, i) => { if (x === 'BL1') { if (last >= 0) gaps.push(i - last); last = i; } });
    const avgTicks = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const seconds = avgTicks * 18;
    assert.ok(seconds > 150 && seconds < 230,
      `expected ~192s per blind ASIN, got ${Math.round(seconds)}s`);
  });
});
