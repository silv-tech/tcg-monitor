/**
 * A restock we cannot send must at least be a restock we can account for.
 *
 * Two failures from the 2026-09-09 Amazon mute, both fixed here.
 *
 * 1. THE ESCAPE BUDGET WAS PER-MUTE. Three restocks per TEN MINUTES. A restart flood spent all
 *    three in the same millisecond it tripped the mute (17:04:54.396), so Amazon then ran for
 *    ten minutes with no protection at all. A suppressed RESTOCK is unrecoverable: poll-adapter
 *    writes the new product state immediately after delivery, so oldProduct.inStock is already
 *    true next poll and events.js can never re-fire it.
 *
 * 2. THE LOSS WAS INVISIBLE. delivery.js logged a suppression only when it was the 1st or every
 *    50th, so of 75 suppressed alerts exactly two were ever written down. Which products they
 *    were could not be established afterwards even in principle.
 *
 * The budget stays deliberately small per window. An unconditional RESTOCK exemption would make
 * the limiter blind to a mass-RESTOCK regression — the exact failure it exists to catch, and why
 * EB Games once produced 289 restock alerts in three days.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const limiter = require('../src/discord/alert-limiter');
const { HIGH_VALUE_TYPES, MUTE_ESCAPE_BUDGET } = require('../src/discord/alert-limiter');

const ev = (type, over = {}) => ({
  type,
  product: {
    retailerId: 'amazon', name: `${type} item`, sku: 'B0' + Math.random().toString(36).slice(2, 10),
    price: 49.99, inStock: true, url: 'https://www.amazon.ca/dp/B0TEST', ...over,
  },
});

function floodUntilMuted() {
  for (let i = 0; i < 80; i++) if (!limiter.allow(ev('NEW_SKU')).allowed) return true;
  assert.fail('precondition: the flood must trip the limiter');
}

beforeEach(() => {
  limiter.reset();
  limiter.setCatalogueSize('amazon', 216);
});

describe('the escape budget refills while the mute holds', () => {
  test('it is exported so delivery can distinguish an unrecoverable loss', () => {
    assert.ok(HIGH_VALUE_TYPES.has('RESTOCK'));
    assert.ok(HIGH_VALUE_TYPES.has('PREORDER_LIVE'));
    assert.ok(MUTE_ESCAPE_BUDGET >= 1);
  });

  test('a restock arriving a minute into the mute still gets through', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      floodUntilMuted();
      let escaped = 0;
      for (let i = 0; i < MUTE_ESCAPE_BUDGET + 2; i++) if (limiter.allow(ev('RESTOCK')).allowed) escaped++;
      assert.strictEqual(escaped, MUTE_ESCAPE_BUDGET, 'precondition: the budget is spent');

      assert.strictEqual(limiter.allow(ev('RESTOCK')).allowed, false, 'exhausted within this minute');

      t.mock.timers.tick(61 * 1000);           // still muted (10 min), but a new window
      assert.strictEqual(limiter.allow(ev('RESTOCK')).allowed, true,
        'before this fix a flood could spend the whole budget in one millisecond and blackhole '
        + 'every genuine restock for the remaining ten minutes');
    } finally { t.mock.timers.reset(); }
  });

  test('the refill is bounded — it is still a limiter', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      floodUntilMuted();
      let escaped = 0;
      for (let i = 0; i < 50; i++) if (limiter.allow(ev('RESTOCK')).allowed) escaped++;
      assert.strictEqual(escaped, MUTE_ESCAPE_BUDGET,
        'a mass-RESTOCK regression inside one minute must not ride through');
    } finally { t.mock.timers.reset(); }
  });

  test('low-value alerts are still suppressed after a refill', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      floodUntilMuted();
      t.mock.timers.tick(61 * 1000);
      for (const type of ['NEW_SKU', 'PRICE_CHANGE', 'SHIPPING_CHANGE', 'LISTING']) {
        assert.strictEqual(limiter.allow(ev(type)).allowed, false, `${type} must stay suppressed`);
      }
    } finally { t.mock.timers.reset(); }
  });

  test('an out-of-stock event never spends the budget', () => {
    floodUntilMuted();
    assert.strictEqual(limiter.allow(ev('RESTOCK', { inStock: false })).allowed, false,
      'nothing is buyable, so nothing is worth escaping for');
  });

  test('the mute still ends on schedule', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      floodUntilMuted();
      t.mock.timers.tick(11 * 60 * 1000);
      assert.strictEqual(limiter.allow(ev('NEW_SKU')).allowed, true, 'the retailer must recover');
    } finally { t.mock.timers.reset(); }
  });
});

describe('a mass-restock regression is still visible to the limiter', () => {
  test('flooding with RESTOCK alone still trips the mute', () => {
    let blocked = 0;
    for (let i = 0; i < 90; i++) if (!limiter.allow(ev('RESTOCK')).allowed) blocked++;
    assert.ok(blocked > 0,
      'if restocks never trip the limiter it is blind to the regression it exists for');
  });

  test('normal traffic below the ceiling is untouched', () => {
    for (let i = 0; i < 10; i++) assert.strictEqual(limiter.allow(ev('RESTOCK')).allowed, true);
  });

  test('a watchlisted product is exempt outright', () => {
    floodUntilMuted();
    assert.strictEqual(limiter.allow(ev('NEW_SKU', { _watchlist: true })).allowed, true);
  });
});
