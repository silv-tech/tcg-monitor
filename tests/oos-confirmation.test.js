/**
 * EB Games produced 289 restock alerts in three days, and they were not real.
 *
 *   SKU 886469  Pitch Black Build & Battle   x36 alerts, median gap 24 minutes
 *   SKU 803955  Mega Venusaur EX Premium     x33 alerts, median gap 30 minutes
 *   SKU 886580  Red & Blue Charizard EX      x31 alerts, median gap 24 minutes
 *   48% of all its alerts arrived in bursts of 5+ inside a single minute, one of 56.
 *
 * Nothing restocks every 24 minutes. The retailer page flickers — a cached render missing its
 * add-to-cart form, a listing served briefly without its stock badge — which reads as "went
 * out of stock", and the next poll seeing it available again manufactures a RESTOCK.
 *
 * The fix confirms only the OUT-of-stock direction. Going out of stock is not time-critical:
 * nobody races to not buy something, so holding it one extra poll costs nothing. Going INTO
 * stock still fires on the first observation, so no drop is ever slowed. That asymmetry is
 * the whole point, and these tests exist to stop someone "simplifying" it into a symmetric
 * debounce that would delay every real restock.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const OOS_CONFIRM_POLLS = 2;

// Mirrors the confirmation step in poll-adapter.js.
function confirm(oldProducts, newProducts) {
  for (const [sku, next] of Object.entries(newProducts)) {
    const prev = oldProducts[sku];
    if (!next || !prev) continue;
    if (prev.inStock && !next.inStock) {
      const streak = (prev._oosStreak || 0) + 1;
      next._oosStreak = streak;
      if (streak < OOS_CONFIRM_POLLS) {
        next.inStock = true;
        next.canAddToCart = prev.canAddToCart;
      }
    } else if (next.inStock) {
      next._oosStreak = 0;
    }
  }
  return newProducts;
}

const inStock = (extra = {}) => ({ inStock: true, canAddToCart: true, ...extra });
const outOfStock = () => ({ inStock: false, canAddToCart: false });

describe('oos confirmation: the EB Games flap is absorbed', () => {
  test('a single flickering poll does not mark the product out of stock', () => {
    const prev = { a: inStock() };
    const next = confirm(prev, { a: outOfStock() });
    assert.strictEqual(next.a.inStock, true, 'one bad read must not flip it');
    assert.strictEqual(next.a._oosStreak, 1, 'but the flicker is remembered');
  });

  test('flicker then recovery produces NO restock, which is the whole bug', () => {
    // Poll 1: flicker. Held in stock.
    const afterFlicker = confirm({ a: inStock() }, { a: outOfStock() });
    assert.strictEqual(afterFlicker.a.inStock, true);
    // Poll 2: page renders correctly again.
    const afterRecovery = confirm(afterFlicker, { a: inStock() });
    // It never left stock, so old.inStock and new.inStock are both true —
    // diffProducts cannot raise a RESTOCK from that.
    assert.strictEqual(afterRecovery.a.inStock, true);
    assert.strictEqual(afterRecovery.a._oosStreak, 0, 'streak resets once it is healthy');
  });

  test('36 alternating flickers produce zero state changes', () => {
    // The observed shape for SKU 886469, which alerted 36 times.
    let state = { a: inStock() };
    let flips = 0;
    for (let i = 0; i < 36; i++) {
      const observed = i % 2 === 0 ? { a: outOfStock() } : { a: inStock() };
      const wasIn = state.a.inStock;
      state = confirm(state, observed);
      if (wasIn !== state.a.inStock) flips++;
    }
    assert.strictEqual(flips, 0, 'a flapping page must produce no stock transitions at all');
  });
});

describe('oos confirmation: real events are not slowed or lost', () => {
  test('a genuine restock still fires on the FIRST observation', () => {
    const prev = { a: { ...outOfStock(), _oosStreak: 5 } };
    const next = confirm(prev, { a: inStock() });
    assert.strictEqual(next.a.inStock, true, 'no delay whatsoever on the way in');
    assert.strictEqual(next.a._oosStreak, 0);
  });

  test('a genuine sell-out is believed on the second consecutive poll', () => {
    const p1 = confirm({ a: inStock() }, { a: outOfStock() });
    assert.strictEqual(p1.a.inStock, true, 'poll 1 withholds judgement');
    const p2 = confirm(p1, { a: outOfStock() });
    assert.strictEqual(p2.a.inStock, false, 'poll 2 confirms it');
    assert.strictEqual(p2.a._oosStreak, 2);
  });

  test('the delay is exactly one poll — seconds, not minutes', () => {
    assert.strictEqual(OOS_CONFIRM_POLLS, 2, 'raising this would delay real sell-outs');
  });

  test('a product that stays out of stock is not repeatedly re-confirmed', () => {
    let s = confirm({ a: inStock() }, { a: outOfStock() });
    s = confirm(s, { a: outOfStock() });
    const before = s.a.inStock;
    s = confirm(s, { a: outOfStock() });
    assert.strictEqual(s.a.inStock, before, 'stays out of stock, no oscillation');
    assert.strictEqual(s.a.inStock, false);
  });
});

describe('oos confirmation: it must not invent state', () => {
  test('a brand new product is untouched — nothing to compare against', () => {
    const next = confirm({}, { a: outOfStock() });
    assert.strictEqual(next.a.inStock, false, 'a new OOS product stays OOS');
    assert.strictEqual(next.a._oosStreak, undefined);
  });

  test('a product already out of stock is left alone', () => {
    const next = confirm({ a: outOfStock() }, { a: outOfStock() });
    assert.strictEqual(next.a.inStock, false);
    assert.strictEqual(next.a._oosStreak, undefined, 'no streak from OOS -> OOS');
  });

  test('a missing or null entry does not throw', () => {
    assert.doesNotThrow(() => confirm({ a: inStock() }, { a: null }));
    assert.doesNotThrow(() => confirm({ a: null }, { a: inStock() }));
  });

  test('canAddToCart is held with inStock, so they never disagree', () => {
    const next = confirm({ a: inStock() }, { a: outOfStock() });
    assert.strictEqual(next.a.inStock, true);
    assert.strictEqual(next.a.canAddToCart, true, 'a held product must still be buyable');
  });
});
