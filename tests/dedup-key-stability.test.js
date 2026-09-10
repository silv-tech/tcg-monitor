/**
 * A dedup key must not change while the alert it guards is in flight.
 *
 * `eventKeys()` is evaluated TWICE for every alert: once by `isDuplicate()` when the event is
 * queued, and again by `markSent()` after the Discord send returns. Everything it reads must
 * therefore be frozen at detection time. Two fields were not.
 *
 * 1. STOCK STATE. The RESTOCK key embedded `product.inStock`, and `event.product` is a reference
 *    into the adapter's own long-lived cache, which the next poll mutates in place. Best Buy polls
 *    every 5s; a send was measured at 4006ms. A poll landing between the two reads flipped inStock
 *    to false, so the check asked for `:1` while the mark wrote `:0` — the `:1` key was never
 *    written, and the next genuine restock passed dedup and alerted again. Reproduced against the
 *    real function on 2026-09-10, which is how this stopped being a theory.
 *
 * 2. RETAILER NAME. The key is also built from `product.retailer`, and 150 of 515 stored Titan Toyz
 *    rows have none. Repairing that field inside `routeEvent` — i.e. between the check and the mark
 *    — would have caused exactly the same mismatch, turning a crash fix into a duplicate-alert bug.
 *    The repair therefore happens in `deliver()`, before dedup runs at all.
 *
 * The invariant these tests defend is deliberately blunt: mutating the product must never change
 * the key. Anything read from the live product object is a latent duplicate-alert bug.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;

const { eventKey, eventKeys } = require('../src/discord/dedup');
const delivery = require('../src/discord/delivery');

const restock = (product) => ({
  type: 'RESTOCK',
  product,
  detail: 'Back in stock',
  oldValue: false,
  newValue: true,
});

const prod = (over = {}) => ({
  retailerId: 'bestbuy', retailer: 'Best Buy Canada', sku: 'BB-1',
  name: 'Pokemon TCG: Mega Evolution Pitch Black Elite Trainer Box',
  price: 59.99, inStock: true, ...over,
});

describe('the key survives the product being mutated underneath it', () => {
  test('flipping inStock after detection does not move the RESTOCK key', () => {
    const p = prod();
    const e = restock(p);
    const before = eventKey(e);

    p.inStock = false;              // the intervening poll
    const after = eventKey(e);

    assert.strictEqual(after, before,
      'check-time and mark-time keys must agree, or the mark lands on a key nothing will ever check');
    assert.match(before, /:1$/, 'a RESTOCK is by definition in stock at detection');
  });

  test('it is pinned to the frozen transition value, not the live object', () => {
    // A product already flipped false, but the event says the transition was into stock.
    const e = restock(prod({ inStock: false }));
    assert.match(eventKey(e), /:1$/,
      'newValue is set once at detection and never mutated — that is the whole point');
  });

  test('the whole key is stable, not just its suffix', () => {
    const p = prod();
    const e = restock(p);
    const before = JSON.stringify(eventKeys(e));
    Object.assign(p, { inStock: false, price: 1.23, name: 'changed', _watchlist: undefined });
    assert.strictEqual(JSON.stringify(eventKeys(e)), before);
  });

  test('a second restock of the same product IS caught as a duplicate', () => {
    // The end the whole mechanism exists for: two RESTOCKs for one SKU share one key.
    const first = restock(prod());
    const second = restock(prod());
    first.product.inStock = false;   // mutate the first one's product after the fact
    assert.strictEqual(eventKey(second), eventKey(first),
      'if these diverge, the second alert is sent to a customer as if it were news');
  });

  test('distinct products still get distinct keys', () => {
    assert.notStrictEqual(eventKey(restock(prod({ sku: 'BB-1' }))), eventKey(restock(prod({ sku: 'BB-2' }))));
    assert.notStrictEqual(
      eventKey(restock(prod({ retailer: 'Best Buy Canada' }))),
      eventKey(restock(prod({ retailer: 'Walmart Canada' }))),
    );
  });

  test('non-RESTOCK keys are unaffected by this change', () => {
    const e = { type: 'PRICE_CHANGE', product: prod(), oldValue: 24.97, newValue: 17.45 };
    const keys = eventKeys(e);
    assert.strictEqual(keys.length, 2, 'the flapping-buy-box pair must still be issued');
    assert.match(keys[1][0], /24\.97>17\.45$/);
  });
});

describe('the retailer name is repaired before dedup, never after', () => {
  test('normalizeRetailer recovers both fields from the url alone', () => {
    const p = { sku: 'X', name: 'Dragon Ball Booster Box', price: 69.99, inStock: true,
      url: 'https://www.titantoyz.com/products/x' };
    delivery.normalizeRetailer(p);
    assert.strictEqual(p.retailerId, 'titantoyz');
    assert.strictEqual(p.retailer, 'Titan Toyz');
  });

  test('it leaves an already-populated product untouched', () => {
    const p = prod();
    delivery.normalizeRetailer(p);
    assert.strictEqual(p.retailerId, 'bestbuy');
    assert.strictEqual(p.retailer, 'Best Buy Canada');
  });

  test('repairing the name AFTER the check would have moved the key — the regression this prevents', () => {
    const p = { sku: 'X', name: 'Dragon Ball Booster Box', price: 69.99, inStock: true,
      url: 'https://www.titantoyz.com/products/x' };
    const e = restock(p);
    const beforeRepair = eventKey(e);
    delivery.normalizeRetailer(p);
    const afterRepair = eventKey(e);
    assert.notStrictEqual(afterRepair, beforeRepair,
      'the key DOES move when the name is filled in — which is exactly why the repair must happen '
      + 'in deliver() before filterDuplicates, and never inside routeEvent between check and mark');
  });

  test('deliver() normalizes every event before dedup can see it', async () => {
    const events = [restock({ sku: 'A', name: 'Dragon Ball Booster Box', price: 69.99, inStock: true,
      url: 'https://www.titantoyz.com/products/a' })];
    delivery.queue.length = 0;
    delivery.processing = true;          // hold the queue so nothing is actually sent
    try {
      await delivery.deliver(events, { skipDedup: true });
    } finally {
      delivery.processing = false;
      delivery.queue.length = 0;
    }
    assert.strictEqual(events[0].product.retailer, 'Titan Toyz');
    assert.strictEqual(events[0].product.retailerId, 'titantoyz');
  });
});
