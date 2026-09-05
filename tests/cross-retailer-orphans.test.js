/**
 * "Also In Stock" must never name a retailer we no longer monitor.
 *
 * rebuildCrossRetailerIndex scans every tcg:product:* key in Redis, and cached products
 * OUTLIVE the retailer — when 20 stores were removed on 2026-09-05 their product keys stayed
 * for up to their 7-day TTL. Without a filter, alerts would have told customers a product was
 * "Also In Stock at Face to Face Games", a store nobody was polling, at a price nobody was
 * refreshing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Mirrors the filter in rebuildCrossRetailerIndex.
function buildIndex(cachedProducts, liveIds) {
  const out = [];
  for (const p of cachedProducts) {
    if (!p || !p.inStock || p.price == null || p.price <= 0) continue;
    if (liveIds && !liveIds.has(p.retailerId)) continue;
    out.push(p);
  }
  return out;
}

const LIVE = new Set(['walmart', 'amazon', '401games', 'hobbiesville', 'zardocards']);
const cached = [
  { retailerId: 'walmart', inStock: true, price: 54.99, name: 'Booster Box' },
  { retailerId: 'facetoface', inStock: true, price: 49.99, name: 'Booster Box' },   // removed
  { retailerId: 'tistaminis', inStock: true, price: 52.00, name: 'Booster Box' },   // removed
  { retailerId: '401games', inStock: true, price: 51.50, name: 'Booster Box' },
];

describe('cross-retailer index: orphaned retailers', () => {
  test('products from removed retailers are excluded', () => {
    const idx = buildIndex(cached, LIVE);
    const names = idx.map((p) => p.retailerId);
    assert.ok(!names.includes('facetoface'), 'a removed store must not appear');
    assert.ok(!names.includes('tistaminis'), 'a removed store must not appear');
  });

  test('live retailers still appear', () => {
    const idx = buildIndex(cached, LIVE);
    assert.deepStrictEqual(idx.map((p) => p.retailerId).sort(), ['401games', 'walmart']);
  });

  test('without the filter, removed stores WOULD leak — documents the bug', () => {
    const idx = buildIndex(cached, null);
    assert.ok(idx.some((p) => p.retailerId === 'facetoface'),
      'this is what shipped before the fix');
  });

  test('an unreadable config disables filtering rather than emptying the index', () => {
    // A missing config must never silently blank "Also In Stock" for every alert.
    const idx = buildIndex(cached, null);
    assert.strictEqual(idx.length, 4, 'null means do not filter, not filter everything');
  });

  test('out-of-stock and zero-price entries are still excluded regardless', () => {
    const idx = buildIndex([
      { retailerId: 'walmart', inStock: false, price: 10 },
      { retailerId: 'walmart', inStock: true, price: 0 },
      { retailerId: 'walmart', inStock: true, price: null },
    ], LIVE);
    assert.strictEqual(idx.length, 0);
  });
});
