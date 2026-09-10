/**
 * One product, one SKU, two variants — and a client's channel got 12 identical alerts.
 *
 * ZardoCards "Celebrations ETB" (product 8926664393016) lists two variants that BOTH carry the
 * sku "ZC-105":
 *
 *   variant 50526702600504  "Normal (1x)"     available: true    $307
 *   variant 50984122843448  "Imperfect (1x)"  available: false   $276
 *
 * Two things then went wrong, and each alone is enough to manufacture a restock out of nothing.
 *
 * 1. LAST WRITE WINS. parseShopifyProduct writes `products[sku]` once per variant, so this row's
 *    inStock depended on whichever variant the response happened to list last. Different code
 *    paths landed on different answers and the row oscillated.
 *
 * 2. SEARCH ATTRIBUTED A PRODUCT-LEVEL FLAG TO ONE VARIANT. `_handleToSku` mapped a handle to its
 *    FIRST variant, and `_searchProducts` then wrote Shopify predictive search's `item.available`
 *    — which is true if ANY variant is purchasable — onto that single variant's row.
 *
 * Every flip to true is a fresh RESTOCK (events.js fires on !old.inStock && new.inStock), so the
 * product alerted continuously. Dedup was working perfectly and was the ONLY brake: the alerts
 * landed exactly 10 minutes apart, which is DEDUP_TTL to the second.
 *
 * The store's own data never moved: 42 consecutive samples of its public Shopify JSON, zero
 * changes. This was entirely self-inflicted, and it is latent for every large Shopify shop on this
 * adapter — grading tiers, condition variants and language variants all produce multi-variant
 * products, and a shop that reuses one SKU across them reproduces it exactly.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;

const ShopifyAdapter = require('../src/adapters/shopify');

const mk = () => new ShopifyAdapter({
  id: 'zardocards', name: 'ZardoCards', url: 'https://zardocards.com',
  intervalMs: 8000, adapter: 'shopify',
});

// The real product, as its public JSON actually returns it.
const CELEBRATIONS = (variantOrder = 'normal-first') => {
  const normal = { id: 50526702600504, title: 'Normal (1x)', sku: 'ZC-105', available: true, price: '307.00', inventory_quantity: 1 };
  const imperfect = { id: 50984122843448, title: 'Imperfect (1x)', sku: 'ZC-105', available: false, price: '276.00', inventory_quantity: 0 };
  return {
    id: 8926664393016,
    title: 'Celebrations ETB',
    handle: 'celebrations-etb',
    published_at: '2026-01-01T00:00:00Z',
    tags: [], vendor: 'ZardoCards', images: [],
    variants: variantOrder === 'normal-first' ? [normal, imperfect] : [imperfect, normal],
  };
};

describe('a sku shared by two variants resolves deterministically', () => {
  test('the row is identical whichever order the variants arrive in', () => {
    const a = {}; const b = {};
    mk().parseShopifyProduct(CELEBRATIONS('normal-first'), a);
    mk().parseShopifyProduct(CELEBRATIONS('imperfect-first'), b);

    assert.strictEqual(a['ZC-105'].inStock, b['ZC-105'].inStock,
      'response ordering decided in-stock — that is the oscillation that flooded the channel');
    assert.strictEqual(a['ZC-105']._variantId, b['ZC-105']._variantId);
  });

  test('the buyable variant wins, because a customer can actually buy it', () => {
    for (const order of ['normal-first', 'imperfect-first']) {
      const out = {};
      mk().parseShopifyProduct(CELEBRATIONS(order), out);
      assert.strictEqual(out['ZC-105'].inStock, true, `order=${order}`);
      assert.strictEqual(out['ZC-105']._variantId, 50526702600504, 'and it is the Normal copy');
    }
  });

  test('re-parsing the same payload never flips the row', () => {
    const out = {};
    const ad = mk();
    const seen = new Set();
    for (let i = 0; i < 6; i++) {
      ad.parseShopifyProduct(CELEBRATIONS(i % 2 ? 'imperfect-first' : 'normal-first'), out);
      seen.add(out['ZC-105'].inStock);
    }
    assert.strictEqual(seen.size, 1, `inStock took ${seen.size} different values across polls: ${[...seen]}`);
  });

  test('a genuinely all-out-of-stock product is still out of stock', () => {
    const p = CELEBRATIONS('normal-first');
    p.variants = p.variants.map((v) => ({ ...v, available: false }));
    const out = {};
    mk().parseShopifyProduct(p, out);
    assert.strictEqual(out['ZC-105'].inStock, false, 'available-wins must not mean always-in-stock');
  });

  test('distinct skus are untouched by the tie-break', () => {
    const p = CELEBRATIONS('normal-first');
    p.variants[1] = { ...p.variants[1], sku: 'ZC-105-IMP' };
    const out = {};
    mk().parseShopifyProduct(p, out);
    assert.strictEqual(Object.keys(out).length, 2, 'two real skus must still produce two rows');
    assert.strictEqual(out['ZC-105'].inStock, true);
    assert.strictEqual(out['ZC-105-IMP'].inStock, false);
  });
});

describe('search cannot attribute a product-level flag to one variant', () => {
  test('a multi-variant handle is not indexed to any single sku', () => {
    const ad = mk();
    ad.parseShopifyProduct(CELEBRATIONS('normal-first'), {});
    assert.strictEqual(ad._handleToSku.has('celebrations-etb'), false,
      'mapping it to one variant is what let search write the product-level flag onto that variant');
    assert.strictEqual(ad._multiVariantHandles.has('celebrations-etb'), true);
  });

  test('a single-variant handle IS still indexed — search keeps working where it is safe', () => {
    const ad = mk();
    const single = {
      id: 1, title: 'Prismatic Evolutions Elite Trainer Box', handle: 'prismatic-etb',
      published_at: '2026-01-01T00:00:00Z', tags: [], vendor: 'x', images: [],
      variants: [{ id: 11, title: 'Default', sku: 'ZC-900', available: true, price: '99.00' }],
    };
    ad.parseShopifyProduct(single, {});
    assert.strictEqual(ad._handleToSku.get('prismatic-etb'), 'ZC-900');
  });

  test('a handle that later gains a second variant is un-indexed, not left stale', () => {
    const ad = mk();
    const single = {
      id: 8926664393016, title: 'Celebrations ETB', handle: 'celebrations-etb',
      published_at: '2026-01-01T00:00:00Z', tags: [], vendor: 'x', images: [],
      variants: [{ id: 50526702600504, title: 'Normal (1x)', sku: 'ZC-105', available: true, price: '307.00' }],
    };
    ad.parseShopifyProduct(single, {});
    assert.strictEqual(ad._handleToSku.get('celebrations-etb'), 'ZC-105', 'indexed while single-variant');

    ad.parseShopifyProduct(CELEBRATIONS('normal-first'), {});
    assert.strictEqual(ad._handleToSku.has('celebrations-etb'), false,
      'a stale index entry would keep search writing the product-level flag onto ZC-105');
  });
});
