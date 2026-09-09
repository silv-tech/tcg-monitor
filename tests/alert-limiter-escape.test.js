/**
 * A genuine restock must survive a flood.
 *
 * A mute drops EVERYTHING for that retailer, and a dropped RESTOCK is lost permanently:
 * poll-adapter writes the new product state immediately after delivery, so oldProduct.inStock is
 * already true on the next poll and events.js can never re-fire it. On 2026-09-09 Amazon was
 * muted for ten minutes and 40 alerts were binned. That flood was harmless first-sightings — but
 * any real restock in the window went with them, unrecoverably, and nobody would ever know.
 *
 * The budget is deliberately small and per-mute. An unconditional exemption would be worse than
 * the problem: the identity exemption returns BEFORE the counter increments, so exempting
 * RESTOCK outright would stop a mass-RESTOCK regression from tripping the limiter at all — the
 * exact failure it exists to catch.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const limiter = require('../src/discord/alert-limiter');

const ev = (type, over = {}) => ({
  type,
  product: { retailerId: 'amazon', name: `${type} item`, sku: 'B0' + Math.random().toString(36).slice(2, 10), price: 49.99, inStock: true, ...over },
});

/** Flood until the retailer is muted, then confirm it is. */
function floodUntilMuted() {
  let muted = false;
  for (let i = 0; i < 60; i++) {
    const v = limiter.allow(ev('NEW_SKU'));
    if (!v.allowed) { muted = true; break; }
  }
  assert.ok(muted, 'precondition: the flood must trip the limiter');
}

beforeEach(() => {
  limiter.reset();   // clears mutes and windows for every retailer
  limiter.setCatalogueSize('amazon', 216);
});

describe('a real restock survives a mute', () => {
  test('a RESTOCK is let through while the retailer is muted', () => {
    floodUntilMuted();
    const v = limiter.allow(ev('RESTOCK'));
    assert.strictEqual(v.allowed, true, 'a restock cannot be re-detected later — it must go now');
    assert.strictEqual(v.escaped, true);
  });

  test('low-value alerts are still suppressed during the mute', () => {
    floodUntilMuted();
    for (const type of ['NEW_SKU', 'PRICE_CHANGE', 'SHIPPING_CHANGE', 'LISTING']) {
      assert.strictEqual(limiter.allow(ev(type)).allowed, false, `${type} must stay suppressed`);
    }
  });

  test('the escape budget is bounded — a mass restock cannot ride through', () => {
    floodUntilMuted();
    let escaped = 0;
    for (let i = 0; i < 40; i++) if (limiter.allow(ev('RESTOCK')).allowed) escaped++;
    assert.ok(escaped > 0, 'some must get through');
    assert.ok(escaped <= 5, `the budget must be small — ${escaped} escaped`);
  });

  test('an out-of-stock event does not spend the budget', () => {
    floodUntilMuted();
    const v = limiter.allow(ev('RESTOCK', { inStock: false }));
    assert.strictEqual(v.allowed, false, 'nothing is in stock, so nothing is worth escaping for');
  });
});

describe('the limiter is still a limiter', () => {
  test('a mass RESTOCK flood still trips the mute', () => {
    let blocked = 0;
    for (let i = 0; i < 80; i++) if (!limiter.allow(ev('RESTOCK')).allowed) blocked++;
    assert.ok(blocked > 0,
      'if restocks never trip the limiter it is blind to the very regression it exists for');
  });

  test('normal traffic below the ceiling is untouched', () => {
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(limiter.allow(ev('RESTOCK')).allowed, true);
    }
  });

  test('a watchlisted product is still exempt outright', () => {
    floodUntilMuted();
    assert.strictEqual(limiter.allow(ev('NEW_SKU', { _watchlist: true })).allowed, true);
  });
});
