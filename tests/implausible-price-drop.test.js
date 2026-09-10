/**
 * A price drop can be too steep to believe, and we told a customer to believe five of them.
 *
 * Real output that reached the client's Discord:
 *
 *   Fusion Strike Sleeved Pack        $5745.00 -> $52.00    (-99%)
 *   Silver Tempest Sleeved Pack       $2650.00 -> $25.00    (-99%)
 *   Paldea Evolved Sleeved Pack       $2900.00 -> $25.00    (-99%)
 *   Brilliant Stars Sleeved Pack       $550.00 -> $30.00    (-95%)
 *   Display of 10 Lost Origin B&B     $7200.00 -> $1650.00  (-77%)
 *
 * None was a discount. Each was a row whose cached price had come from the WRONG VARIANT of a
 * multi-variant product, so the HIGH number was the corruption and the low one was correct. The
 * proof is arithmetic: the Lost Origin display of ten now reads $1650 against a single box at
 * $165 — exactly ten times — while $7200 has no such relationship to anything the store sells.
 *
 * An existing guard already suppressed a 100x currency-unit shift, but it only tolerates a ratio
 * within 0.5 of exactly 100, and these landed at 110.5, 106, 116, 18.3 and 4.4. It was built for
 * one specific bug and correctly did not fire outside it.
 *
 * THE THRESHOLD IS DELIBERATELY CONSERVATIVE. Measured across seven live catalogues, genuine
 * clearance sits in the 30-50% band and nothing real approached 90%. A real drop is the most
 * valuable alert this system sends, so the guard is set where it cannot plausibly eat one — which
 * knowingly leaves the -77% case through. Closing that gap needs confirmation on a second
 * observation, not a deeper floor, and is a separate change.
 *
 * One hypothesis was tested and REJECTED on the data rather than shipped: that a quantity-tier
 * artifact would show a near-integer ratio (10x, 36x). The worst case measured 110.481 — the
 * furthest a ratio can sit from any integer — while a genuine discount ($675 -> $565) scored
 * closer to one. The signature does not exist; do not reintroduce it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { detectEvents, EVENT_TYPES } = require('../src/core/events');

const p = (over = {}) => ({
  retailerId: 'zardocards', sku: 'ZC-1', name: 'Pokemon TCG Sleeved Pack',
  price: 100, inStock: true, canAddToCart: true, ...over,
});

const priceMove = (from, to) => detectEvents(p({ price: from }), p({ price: to }))
  .filter((e) => e.type === EVENT_TYPES.PRICE_CHANGE);

describe('the five drops that actually reached a customer', () => {
  const REAL = [
    ['Fusion Strike Sleeved Pack', 5745, 52],
    ['Silver Tempest Sleeved Pack', 2650, 25],
    ['Paldea Evolved Sleeved Pack', 2900, 25],
    ['Brilliant Stars Sleeved Pack', 550, 30],
  ];
  for (const [name, from, to] of REAL) {
    test(`${name} $${from} -> $${to} is suppressed`, () => {
      assert.deepStrictEqual(priceMove(from, to), [],
        'a sealed pack is not sold at a fraction of its price — this is bad data, not a discount');
    });
  }

  test('the -77% case is knowingly NOT suppressed, and that is a documented limit', () => {
    // Display of 10 Lost Origin B&B, $7200 -> $1650. Real artifact, but 77% is inside the band
    // where a genuine blowout sale can live. Recorded here so the gap is deliberate, not forgotten.
    assert.strictEqual(priceMove(7200, 1650).length, 1);
  });
});

describe('real discounts still alert — the property that matters most', () => {
  for (const [from, to, pct] of [[100, 65, 35], [200, 100, 50], [675, 565, 16], [59.99, 49.99, 17]]) {
    test(`a ${pct}% drop ($${from} -> $${to}) still fires`, () => {
      assert.strictEqual(priceMove(from, to).length, 1,
        'suppressing a genuine drop costs the client more than any amount of artifact noise');
    });
  }

  test('a drop just under the ceiling still fires', () => {
    assert.strictEqual(priceMove(100, 10.5).length, 1, '-89.5% is steep but permitted');
  });

  test('a drop just past the ceiling does not', () => {
    assert.deepStrictEqual(priceMove(100, 9.5), [], '-90.5% is past the line');
  });
});

describe('the existing guards are unchanged', () => {
  test('a move below the 9% minimum still does not alert', () => {
    assert.deepStrictEqual(priceMove(100, 95), []);
  });

  test('a price INCREASE still does not alert', () => {
    assert.deepStrictEqual(priceMove(100, 300), []);
  });

  test('an exact 100x currency-unit shift is still caught by its own guard', () => {
    assert.deepStrictEqual(priceMove(1000, 10), []);
  });

  test('null or zero prices are still ignored', () => {
    assert.deepStrictEqual(detectEvents(p({ price: null }), p({ price: 50 })).filter((e) => e.type === EVENT_TYPES.PRICE_CHANGE), []);
    assert.deepStrictEqual(priceMove(0, 50), []);
  });
});

describe('suppression is recorded, never silent', () => {
  test('an implausible drop is logged with everything needed to chase the row', () => {
    const logger = require('../src/monitoring/logger');
    const realWarn = logger.warn;
    const lines = [];
    logger.warn = (m) => { lines.push(String(m)); };
    try {
      detectEvents(p({ price: 5745 }), p({ price: 52, sku: 'ZC-58', name: 'Fusion Strike Sleeved Pack' }));
    } finally {
      logger.warn = realWarn;
    }
    const line = lines.find((l) => l.includes('IMPLAUSIBLE PRICE DROP'));
    assert.ok(line, 'silently dropping it would hide the identity defect that produced it');
    assert.match(line, /ZC-58/, 'must name the sku');
    assert.match(line, /Fusion Strike/, 'and the product');
    assert.match(line, /110\.5x/, 'and the ratio, which is the diagnostic signal');
  });
});
