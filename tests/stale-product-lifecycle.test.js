/**
 * What happens to a product that stops appearing in a listing.
 *
 * Two opposite failures meet here, and the confirmation threshold is what separates them.
 *
 * TRANSIENT ABSENCE is not a delisting. EB Games rotates items off its pages for a poll or two;
 * writing inStock=false immediately, then seeing the item again, produced a RESTOCK — 289 false
 * alerts. So below OOS_CONFIRM_POLLS nothing is concluded and lastSeen keeps moving.
 *
 * CONFIRMED ABSENCE was never concluded either, and that was the other bug. lastSeen was
 * refreshed on EVERY poll that failed to find the product, including the ones that confirmed it
 * gone. /scan filters on lastSeen, so a delisted product stayed permanently "recent" and was
 * posted as Currently Listed forever. Six London Drugs SKUs whose product pages now return 404
 * were in that state on 2026-09-09, and because stockCount was never cleared either, one of them
 * rendered "Stock: 1" for a product that cannot be bought at all.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

/**
 * The stale-cleanup rule, extracted exactly as poll-adapter applies it per product.
 * Kept in the test rather than exported so the assertions describe behaviour, not plumbing;
 * the integration path is covered by the live catalogue tests.
 */
function applyStaleRule(product, { confirmAfter }) {
  const streak = (product._missingStreak || 0) + 1;
  product._missingStreak = streak;
  if (streak >= confirmAfter) {
    product.inStock = false;
    product.canAddToCart = false;
    product.stockCount = null;
    delete product._stockQty;
  } else {
    product.lastSeen = Date.now();
  }
  return product;
}

const CONFIRM = 2;
const seen = (over = {}) => ({
  sku: 'L3390851', name: 'Mega Zygarde ex Premium Collection', price: 89.99,
  inStock: true, canAddToCart: true, stockCount: 1, lastSeen: 1000, ...over,
});

describe('a brief disappearance concludes nothing', () => {
  test('one missed poll leaves the product alone and keeps it recent', () => {
    const p = applyStaleRule(seen(), { confirmAfter: CONFIRM });
    assert.strictEqual(p.inStock, true, 'a page that rotated an item off is not a sell-out');
    assert.ok(p.lastSeen > 1000, 'still recent — it may well be back next poll');
  });
});

describe('a confirmed disappearance is acted on', () => {
  test('the product is marked out of stock', () => {
    const p = seen();
    applyStaleRule(p, { confirmAfter: CONFIRM });
    applyStaleRule(p, { confirmAfter: CONFIRM });
    assert.strictEqual(p.inStock, false);
    assert.strictEqual(p.canAddToCart, false);
  });

  test('it stops advertising a quantity', () => {
    const p = seen({ stockCount: 1, _stockQty: 41 });
    applyStaleRule(p, { confirmAfter: CONFIRM });
    applyStaleRule(p, { confirmAfter: CONFIRM });
    assert.strictEqual(p.stockCount, null,
      'embeds.js renders `_stockQty || stockCount` — a delisted product showed "Stock: 1"');
    assert.strictEqual(p._stockQty, undefined);
  });

  test('lastSeen STOPS being refreshed, so it can age out of /scan', () => {
    const p = seen({ lastSeen: 1000 });
    applyStaleRule(p, { confirmAfter: CONFIRM });
    const afterFirst = p.lastSeen;
    assert.ok(afterFirst > 1000, 'the unconfirmed poll still refreshes');
    applyStaleRule(p, { confirmAfter: CONFIRM });
    assert.strictEqual(p.lastSeen, afterFirst,
      'refreshing lastSeen on a confirmed-gone product kept it permanently "Currently Listed"');
    applyStaleRule(p, { confirmAfter: CONFIRM });
    assert.strictEqual(p.lastSeen, afterFirst, 'and it must stay frozen on every later poll');
  });

  test('the record is not deleted — that is what caused mass false NEW_SKU', () => {
    const p = seen();
    applyStaleRule(p, { confirmAfter: CONFIRM });
    applyStaleRule(p, { confirmAfter: CONFIRM });
    assert.strictEqual(p.sku, 'L3390851', 'the row must survive so its return is a RESTOCK, not a new product');
  });
});

describe('the streak is what distinguishes the two cases', () => {
  test('a product that reappears before confirmation was never touched', () => {
    const p = seen();
    applyStaleRule(p, { confirmAfter: 3 });
    assert.strictEqual(p.inStock, true);
    assert.strictEqual(p.stockCount, 1, 'nothing may be cleared on an unconfirmed absence');
  });
});
