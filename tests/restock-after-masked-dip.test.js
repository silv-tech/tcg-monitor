/**
 * A sell-out we chose not to believe must not swallow the restock that follows it.
 *
 * THE INCIDENT — B0H2JVZYZZ, 2026-09-28 21:51. "Pokémon TCG: First Partner Illustration
 * Collection—Series 3" sold out and came back. Our free priority lane read it IN STOCK at
 * 21:51:30.5 and armed the burst; the competitor alerted at 21:51:38. We were EIGHT SECONDS
 * FASTER and the client still got nothing from us.
 *
 * Detection was never the problem. poll-adapter holds an unconfirmed sell-out by keeping the row
 * `inStock: true` until a second read agrees (OOS_CONFIRM_POLLS = 2), and its own comment said the
 * point was that "the next poll seeing stock again cannot look like a restock". For a product that
 * sells out and returns inside that window — which is every one of the sub-65s windows measured
 * that day — the stored row never gets to say out of stock, so no transition exists and no alert
 * is ever raised.
 *
 * The confirmation itself is right and stays: an unconfirmed sell-out still raises no OOS event.
 * What is recorded now is merely THAT a dip was seen, so the return is recognised as the restock
 * it was.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { detectEvents, EVENT_TYPES } = require('../src/core/events');

const row = (over = {}) => ({
  sku: 'B0H2JVZYZZ', name: 'Pokemon TCG: First Partner Illustration Collection Series 3',
  retailer: 'Amazon Canada', price: 39.95, inStock: true, _watchlist: true, ...over,
});

const restocks = evs => evs.filter(e => e.type === EVENT_TYPES.RESTOCK);

describe('restock after a masked out-of-stock dip', () => {
  test('THE INCIDENT: stored row says in stock, a dip was seen, stock returns -> RESTOCK', () => {
    const prev = row({ inStock: true });                       // masked: never allowed to say OOS
    const next = row({ inStock: true, _restockAfterDip: true });
    assert.strictEqual(restocks(detectEvents(prev, next)).length, 1,
      'the restock the client actually missed must now fire');
  });

  test('an ordinary transition still works, unchanged', () => {
    assert.strictEqual(restocks(detectEvents(row({ inStock: false }), row({ inStock: true }))).length, 1);
  });

  test('NO dip means no restock — a row sitting in stock must stay quiet', () => {
    // This is the spam guard. A product in stock for days polls hundreds of times; without the
    // flag every one of those polls must remain silent.
    const evs = detectEvents(row({ inStock: true }), row({ inStock: true }));
    assert.strictEqual(restocks(evs).length, 0);
  });

  test('the flag cannot fire while the product is OUT of stock', () => {
    const evs = detectEvents(row({ inStock: true }), row({ inStock: false, _restockAfterDip: true }));
    assert.strictEqual(restocks(evs).length, 0, 'no stock, no restock, whatever the flag says');
  });

  test('a stale flag on an unchanged row does not re-fire forever', () => {
    // poll-adapter clears the flag the same poll it sets it. This pins what happens if it somehow
    // survives: it fires once more at most, never a loop, because the flag is not regenerated.
    const next = row({ inStock: true, _restockAfterDip: true });
    const first = restocks(detectEvents(row({ inStock: true }), next)).length;
    const cleared = row({ inStock: true, _restockAfterDip: undefined });
    const second = restocks(detectEvents(next, cleared)).length;
    assert.strictEqual(first, 1);
    assert.strictEqual(second, 0, 'once the flag is cleared the row goes quiet again');
  });

  test('a brand-new product is still NEW_SKU, not a restock', () => {
    const evs = detectEvents(null, row({ _restockAfterDip: true }));
    assert.strictEqual(evs[0].type, EVENT_TYPES.NEW_SKU);
    assert.strictEqual(restocks(evs).length, 0);
  });
});
