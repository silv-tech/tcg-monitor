/**
 * Some Pokemon Center pages cannot be fetched at all, by anyone.
 *
 * Verified directly rather than inferred: three SKUs failed six times out of six, from two
 * different networks, each returning HTTP 200 with a ZERO-byte body after 55-106 seconds.
 * Not our timeout, not a block page — Bright Data simply cannot render those pages.
 *
 *   10-10193-102   65s, 73s, 106s, 81s
 *   bundle1099     80s, 100s, 71s, 63s
 *   10-10416-109   99s, 55s, 62s
 *
 * Left alone the rotation retries them forever at roughly 160s per product. At ~400 checks a
 * day against 1,195 products, every slot spent on an unfetchable page is a fetchable one that
 * never gets looked at — which is what held the priced count near zero even after the fetch
 * layer started working.
 *
 * Parking them is a throughput fix, not a correctness one, so it is deliberately reversible:
 * the cooldown expires and the SKU is tried again in case the vendor improves.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const UNFETCHABLE_AFTER = 2;
const COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Mirrors _noteCheckOutcome / _isUnfetchable in the adapter.
function makeTracker() {
  const failStreak = new Map();
  const parked = new Map();
  return {
    parked,
    note(sku, ok, now = Date.now()) {
      if (ok) { if (failStreak.delete(sku)) parked.delete(sku); return; }
      const streak = (failStreak.get(sku) || 0) + 1;
      failStreak.set(sku, streak);
      if (streak >= UNFETCHABLE_AFTER && !parked.has(sku)) parked.set(sku, { until: now + COOLDOWN_MS });
    },
    isParked(sku, now = Date.now()) {
      const e = parked.get(sku);
      if (!e) return false;
      if (now >= e.until) { parked.delete(sku); return false; }
      return true;
    },
  };
}

describe('unfetchable SKUs: the budget stops being wasted', () => {
  test('a single failure does not park a product', () => {
    const t = makeTracker();
    t.note('10-10193-102', false);
    assert.strictEqual(t.isParked('10-10193-102'), false, 'one bad fetch could be transient');
  });

  test('two consecutive total failures parks it', () => {
    const t = makeTracker();
    t.note('10-10193-102', false);
    t.note('10-10193-102', false);
    assert.strictEqual(t.isParked('10-10193-102'), true);
  });

  test('the three real unfetchable products all end up parked', () => {
    const t = makeTracker();
    for (const sku of ['10-10193-102', 'bundle1099', '10-10416-109']) {
      t.note(sku, false); t.note(sku, false);
      assert.strictEqual(t.isParked(sku), true, sku);
    }
    assert.strictEqual(t.parked.size, 3);
  });
});

describe('unfetchable SKUs: nothing is parked permanently', () => {
  test('a success clears the streak before parking', () => {
    const t = makeTracker();
    t.note('x', false);
    t.note('x', true);
    t.note('x', false);
    assert.strictEqual(t.isParked('x'), false, 'failures must be CONSECUTIVE');
  });

  test('a success un-parks a product that recovers', () => {
    const t = makeTracker();
    t.note('x', false); t.note('x', false);
    assert.strictEqual(t.isParked('x'), true);
    t.note('x', true);
    assert.strictEqual(t.isParked('x'), false, 'the vendor may improve; do not park forever');
  });

  test('the cooldown expires and the product is retried', () => {
    const t = makeTracker();
    const now = Date.now();
    t.note('x', false, now); t.note('x', false, now);
    assert.strictEqual(t.isParked('x', now + COOLDOWN_MS - 1000), true);
    assert.strictEqual(t.isParked('x', now + COOLDOWN_MS + 1000), false);
  });

  test('a fetchable product is never parked', () => {
    const t = makeTracker();
    for (let i = 0; i < 20; i++) t.note('good', true);
    assert.strictEqual(t.isParked('good'), false);
  });
});
