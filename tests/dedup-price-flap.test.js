/**
 * A marketplace buy box flaps between sellers, so the price oscillates between two values
 * and every swing back down re-presents an IDENTICAL drop.
 *
 * Dedup keyed only on `${type}:${retailer}:${sku}` with a 10-minute TTL let that re-fire up
 * to six times an hour, forever. B0GX7S11S3 sent the identical "$24.97 -> $17.45 (-30%)"
 * 21 times on 2026-09-05 before the alert limiter muted Amazon for 10 minutes.
 *
 * The fix adds a second gate keyed on the transition itself, held for 6 hours. The rule it
 * has to satisfy: suppress repetition, never suppress news.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { eventKeys, REPEAT_PRICE_TTL } = require('../src/discord/dedup');

const priceEvent = (sku, oldValue, newValue) => ({
  type: 'PRICE_CHANGE',
  product: { retailer: 'Amazon Canada', sku, inStock: true },
  oldValue,
  newValue,
});
const keysOf = (e) => eventKeys(e).map(([k]) => k);

describe('dedup: an identical price transition is suppressed', () => {
  test('the same drop produces the same transition key', () => {
    const a = keysOf(priceEvent('B0GX7S11S3', 24.97, 17.45));
    const b = keysOf(priceEvent('B0GX7S11S3', 24.97, 17.45));
    assert.deepStrictEqual(a, b);
  });

  test('the transition gate is held far longer than the 10-minute window', () => {
    const [, transition] = eventKeys(priceEvent('B0GX7S11S3', 24.97, 17.45));
    assert.strictEqual(transition[1], REPEAT_PRICE_TTL);
    assert.ok(REPEAT_PRICE_TTL >= 6 * 3600, 'must outlast a flapping buy box');
  });

  test('the transition is actually in the key, not just the sku', () => {
    const [, [key]] = eventKeys(priceEvent('B0GX7S11S3', 24.97, 17.45));
    assert.ok(key.includes('24.97>17.45'), key);
  });
});

describe('dedup: genuinely new price news still gets through', () => {
  test('a drop to a different price is a different key', () => {
    const a = keysOf(priceEvent('B0GX7S11S3', 24.97, 17.45));
    const b = keysOf(priceEvent('B0GX7S11S3', 24.97, 12.00));
    assert.notDeepStrictEqual(a, b);
  });

  test('a drop from a different baseline is a different key', () => {
    const a = keysOf(priceEvent('B0GW2DK37Q', 68.95, 39.95));
    const b = keysOf(priceEvent('B0GW2DK37Q', 64.95, 39.95));
    assert.notDeepStrictEqual(a, b);
  });

  test('a stepped drop alerts at each step', () => {
    const step1 = keysOf(priceEvent('B0X', 100, 80));
    const step2 = keysOf(priceEvent('B0X', 80, 60));
    assert.notDeepStrictEqual(step1, step2);
  });

  test('different products never share a key', () => {
    assert.notDeepStrictEqual(
      keysOf(priceEvent('B0GX7S11S3', 24.97, 17.45)),
      keysOf(priceEvent('B0GW2DK37Q', 24.97, 17.45))
    );
  });
});

describe('dedup: existing behaviour is unchanged', () => {
  test('a price event still carries the original short-window sku gate', () => {
    const [primary] = eventKeys(priceEvent('B0GX7S11S3', 24.97, 17.45));
    assert.strictEqual(primary[0], 'tcg:dedup:PRICE_CHANGE:Amazon Canada:B0GX7S11S3');
    assert.strictEqual(primary[1], 600);
  });

  test('restock still keys on stock state so OOS -> in -> OOS -> in all fire', () => {
    const base = { type: 'RESTOCK', product: { retailer: 'Amazon Canada', sku: 'B0X' } };
    const inStock = eventKeys({ ...base, product: { ...base.product, inStock: true } })[0][0];
    const outStock = eventKeys({ ...base, product: { ...base.product, inStock: false } })[0][0];
    assert.notStrictEqual(inStock, outStock);
    assert.ok(inStock.endsWith(':1') && outStock.endsWith(':0'));
  });

  test('a watchlist restock keeps its short 45s window for drop waves', () => {
    const e = { type: 'RESTOCK', product: { retailer: 'Amazon Canada', sku: 'B0X', inStock: true, _watchlist: true } };
    assert.strictEqual(eventKeys(e)[0][1], 45);
  });

  test('other event types are untouched — one gate, 10 minutes', () => {
    const e = { type: 'NEW_SKU', product: { retailer: 'Amazon Canada', sku: 'B0X' } };
    assert.deepStrictEqual(eventKeys(e), [['tcg:dedup:NEW_SKU:Amazon Canada:B0X', 600]]);
  });

  test('a price event missing its values falls back to the plain single gate', () => {
    const e = { type: 'PRICE_CHANGE', product: { retailer: 'Amazon Canada', sku: 'B0X' } };
    assert.deepStrictEqual(eventKeys(e), [['tcg:dedup:PRICE_CHANGE:Amazon Canada:B0X', 600]]);
  });
});
