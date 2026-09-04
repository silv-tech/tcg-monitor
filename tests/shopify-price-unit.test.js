const { test, describe } = require('node:test');
const assert = require('node:assert');
const { diffProducts } = require('../src/core/events');

// Mirrors _detectPriceUnit in shopify.js
function detectCents(values) {
  if (values.length < 25) return null;
  return values.filter((n) => n % 100 === 0).length / values.length >= 0.99;
}

describe('shopify: price unit detection', () => {
  test('a store quoting cents is detected (hobbiesville: 696/696 round)', () => {
    const values = Array.from({ length: 696 }, (_, i) => (i + 1) * 100);
    assert.strictEqual(detectCents(values), true);
  });

  test('a store quoting dollars is detected (kanzengames: 30/638 round)', () => {
    const values = [];
    for (let i = 0; i < 608; i++) values.push(10 + i * 0.95);
    for (let i = 0; i < 30; i++) values.push(400);
    assert.strictEqual(detectCents(values), false);
  });

  test('one round price does not make a dollars store look like cents', () => {
    const values = [400, 159.95, 42.95, 750, 0.3, 12.99];
    for (let i = 0; i < 30; i++) values.push(19.99);
    assert.strictEqual(detectCents(values), false);
  });

  test('too few samples returns no verdict rather than guessing', () => {
    assert.strictEqual(detectCents([100, 200, 300]), null);
  });
});

describe('events: a 100x unit shift is not a price drop', () => {
  const base = { sku: 'X', name: 'Deck Box', retailer: 'Hobbiesville', retailerId: 'hobbiesville', inStock: true, canAddToCart: true };

  test('1300 -> 13 (cents fix applied) fires NO price alert', () => {
    const events = diffProducts({ X: { ...base, price: 1300 } }, { X: { ...base, price: 13 } });
    assert.strictEqual(events.filter((e) => e.type === 'PRICE_CHANGE').length, 0,
      'a unit correction must not read as a 99% crash');
  });

  test('13 -> 1300 (unit shift the other way) also fires nothing', () => {
    const events = diffProducts({ X: { ...base, price: 13 } }, { X: { ...base, price: 1300 } });
    assert.strictEqual(events.filter((e) => e.type === 'PRICE_CHANGE').length, 0);
  });

  test('a genuine large drop still alerts', () => {
    const events = diffProducts({ X: { ...base, price: 100 } }, { X: { ...base, price: 40 } });
    assert.strictEqual(events.filter((e) => e.type === 'PRICE_CHANGE').length, 1,
      'a real 60% drop must still fire');
  });

  test('a normal 10% drop still alerts', () => {
    const events = diffProducts({ X: { ...base, price: 50 } }, { X: { ...base, price: 44 } });
    assert.strictEqual(events.filter((e) => e.type === 'PRICE_CHANGE').length, 1);
  });

  test('a near-100x but real move is not suppressed too eagerly', () => {
    // 80x is not a unit shift; it should still be treated as a (very large) real drop
    const events = diffProducts({ X: { ...base, price: 800 } }, { X: { ...base, price: 10 } });
    assert.strictEqual(events.filter((e) => e.type === 'PRICE_CHANGE').length, 1);
  });
});
