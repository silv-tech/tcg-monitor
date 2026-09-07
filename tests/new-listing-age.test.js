/**
 * "New to us" is not the same as "new".
 *
 * When the Shopify sweep began rotating through the deep pages of a catalogue, every page it
 * reached for the first time was full of products that had been on sale for months — and each
 * one looked like a brand new listing to the diff. Remi Card Trader produced 332 events in a
 * single poll that way and was muted by the limiter; Deck Out Gaming produced 26.
 *
 * The seen-set cannot catch this: those SKUs genuinely had never been seen. published_at can,
 * because a real new listing is minutes or hours old.
 *
 * The other half of the same incident is here too: the alert ceiling was being told the size
 * of the POLL rather than the size of the STORE, so a 27-product fast poll at a 4,497-product
 * shop scaled to a ceiling of 1 and collapsed to the floor.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const NEW_LISTING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DAY = 86400000;

// Mirrors the NEW_SKU age filter in poll-adapter.js.
function keepNewSku(product, now = Date.now()) {
  const published = product && product.publishedAt;
  if (!published) return true;                     // no date exposed — cannot judge, so allow
  return now - published <= NEW_LISTING_MAX_AGE_MS;
}

describe('NEW_SKU is judged on when the RETAILER listed the product', () => {
  test('a listing published minutes ago is genuinely new', () => {
    assert.strictEqual(keepNewSku({ publishedAt: Date.now() - 5 * 60 * 1000 }), true);
  });

  test('a listing published two days ago is still treated as new', () => {
    assert.strictEqual(keepNewSku({ publishedAt: Date.now() - 2 * DAY }), true);
  });

  test('a product listed six months ago is NOT a new listing', () => {
    assert.strictEqual(keepNewSku({ publishedAt: Date.now() - 180 * DAY }), false,
      'this is the deep-page case that produced 332 events in one poll');
  });

  test('a shop that exposes no date is unaffected', () => {
    assert.strictEqual(keepNewSku({ publishedAt: null }), true);
    assert.strictEqual(keepNewSku({}), true);
  });
});

describe('the Shopify adapter actually supplies publishedAt', () => {
  // The filter above is inert unless the field really reaches the event, so pin the wiring.
  test('parseShopifyProduct sets publishedAt from the listing', () => {
    const ShopifyAdapter = require('../src/adapters/shopify');
    const a = new ShopifyAdapter({
      id: 's', name: 'S', url: 'https://example.com', adapter: 'shopify',
      collections: [], searchKeywords: [],
    });
    const out = {};
    a.parseShopifyProduct({
      id: 1, title: 'Pokemon TCG Scarlet & Violet Booster Bundle', handle: 'p1',
      product_type: 'TCG', tags: [], published_at: '2026-01-15T10:00:00Z',
      variants: [{ id: 11, price: '49.99', available: true }],
    }, out);
    const p = Object.values(out)[0];
    assert.ok(p, 'the product should parse');
    assert.strictEqual(p.publishedAt, Date.parse('2026-01-15T10:00:00Z'));
  });
});

describe('the alert ceiling is told the size of the store, not the poll', () => {
  const limiter = require('../src/discord/alert-limiter');

  test('a small fast poll at a large shop keeps the large ceiling', () => {
    limiter.reset();
    // What poll-adapter now passes: max(newCount, oldCount).
    const newCount = 27, oldCount = 4497;
    limiter.setCatalogueSize('remicardtrader', Math.max(newCount, oldCount));
    assert.strictEqual(limiter.limitFor('remicardtrader'), 90);
  });

  test('passing the poll slice alone would have collapsed it to the floor', () => {
    limiter.reset();
    limiter.setCatalogueSize('someshop', 27);      // the old, wrong value
    assert.strictEqual(limiter.limitFor('someshop'), limiter.MIN_LIMIT,
      'this is why Remi Card Trader was muted at 15 instead of ~90');
  });
});
