const assert = require('assert');
const { describe, it } = require('node:test');
const { EVENT_TYPES, detectEvents, diffProducts } = require('../src/core/events');

function makeProduct(overrides = {}) {
  return {
    sku: 'TEST-001',
    name: 'Pokemon Booster Box',
    price: 199.99,
    currency: 'CAD',
    url: 'https://example.com/product/TEST-001',
    image: 'https://example.com/img.jpg',
    retailer: 'Test Store',
    inStock: true,
    canAddToCart: true,
    category: 'pokemon',
    productType: 'booster-box',
    lastSeen: Date.now(),
    shipsToHome: true,
    ...overrides,
  };
}

describe('detectEvents', () => {
  it('NEW_SKU when no old product exists', () => {
    const newProd = makeProduct();
    const events = detectEvents(null, newProd);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, EVENT_TYPES.NEW_SKU);
    assert.strictEqual(events[0].product.sku, 'TEST-001');
  });

  it('RESTOCK when out of stock → in stock', () => {
    const old = makeProduct({ inStock: false });
    const newProd = makeProduct({ inStock: true });
    const events = detectEvents(old, newProd);
    const restock = events.find(e => e.type === EVENT_TYPES.RESTOCK);
    assert.ok(restock, 'Should emit RESTOCK event');
  });

  it('no RESTOCK when already in stock', () => {
    const old = makeProduct({ inStock: true });
    const newProd = makeProduct({ inStock: true });
    const events = detectEvents(old, newProd);
    const restock = events.find(e => e.type === EVENT_TYPES.RESTOCK);
    assert.strictEqual(restock, undefined);
  });

  it('PRICE_CHANGE when price differs', () => {
    const old = makeProduct({ price: 199.99 });
    const newProd = makeProduct({ price: 149.99 });
    const events = detectEvents(old, newProd);
    const priceChange = events.find(e => e.type === EVENT_TYPES.PRICE_CHANGE);
    assert.ok(priceChange, 'Should emit PRICE_CHANGE event');
    assert.strictEqual(priceChange.oldValue, 199.99);
    assert.strictEqual(priceChange.newValue, 149.99);
    assert.ok(priceChange.detail.includes('dropped'));
  });

  it('PRICE_CHANGE with increase', () => {
    const old = makeProduct({ price: 100 });
    const newProd = makeProduct({ price: 120 });
    const events = detectEvents(old, newProd);
    const priceChange = events.find(e => e.type === EVENT_TYPES.PRICE_CHANGE);
    assert.ok(priceChange);
    assert.ok(priceChange.detail.includes('increased'));
  });

  it('no PRICE_CHANGE when prices are equal', () => {
    const old = makeProduct({ price: 199.99 });
    const newProd = makeProduct({ price: 199.99 });
    const events = detectEvents(old, newProd);
    assert.strictEqual(events.length, 0);
  });

  it('CART_AVAILABLE when canAddToCart flips true', () => {
    const old = makeProduct({ canAddToCart: false });
    const newProd = makeProduct({ canAddToCart: true });
    const events = detectEvents(old, newProd);
    const cart = events.find(e => e.type === EVENT_TYPES.CART_AVAILABLE);
    assert.ok(cart);
  });

  it('SHIPPING_CHANGE when ships to home flips true', () => {
    const old = makeProduct({ shipsToHome: false });
    const newProd = makeProduct({ shipsToHome: true });
    const events = detectEvents(old, newProd);
    const shipping = events.find(e => e.type === EVENT_TYPES.SHIPPING_CHANGE);
    assert.ok(shipping);
  });

  it('PREORDER_LIVE when isPreorderable flips true', () => {
    const old = makeProduct({ isPreorderable: false });
    const newProd = makeProduct({ isPreorderable: true });
    const events = detectEvents(old, newProd);
    const preorder = events.find(e => e.type === EVENT_TYPES.PREORDER_LIVE);
    assert.ok(preorder, 'Should emit PREORDER_LIVE event');
    assert.ok(preorder.detail.includes('Pre-order'));
  });

  it('multiple events can fire simultaneously', () => {
    const old = makeProduct({ inStock: false, canAddToCart: false, price: 200 });
    const newProd = makeProduct({ inStock: true, canAddToCart: true, price: 150 });
    const events = detectEvents(old, newProd);
    assert.ok(events.length >= 3, `Expected 3+ events, got ${events.length}`);
    const types = events.map(e => e.type);
    assert.ok(types.includes(EVENT_TYPES.RESTOCK));
    assert.ok(types.includes(EVENT_TYPES.PRICE_CHANGE));
    assert.ok(types.includes(EVENT_TYPES.CART_AVAILABLE));
  });

  it('no events when nothing changes', () => {
    const old = makeProduct();
    const newProd = makeProduct();
    const events = detectEvents(old, newProd);
    assert.strictEqual(events.length, 0);
  });
});

describe('diffProducts', () => {
  it('detects new SKUs in batch', () => {
    const oldProducts = {};
    const newProducts = {
      'SKU-1': makeProduct({ sku: 'SKU-1', name: 'Product A' }),
      'SKU-2': makeProduct({ sku: 'SKU-2', name: 'Product B' }),
    };
    const events = diffProducts(oldProducts, newProducts);
    assert.strictEqual(events.length, 2);
    assert.ok(events.every(e => e.type === EVENT_TYPES.NEW_SKU));
  });

  it('detects restocks across multiple SKUs', () => {
    const oldProducts = {
      'SKU-1': makeProduct({ sku: 'SKU-1', inStock: false }),
      'SKU-2': makeProduct({ sku: 'SKU-2', inStock: true }),
      'SKU-3': makeProduct({ sku: 'SKU-3', inStock: false }),
    };
    const newProducts = {
      'SKU-1': makeProduct({ sku: 'SKU-1', inStock: true }),
      'SKU-2': makeProduct({ sku: 'SKU-2', inStock: true }),
      'SKU-3': makeProduct({ sku: 'SKU-3', inStock: true }),
    };
    const events = diffProducts(oldProducts, newProducts);
    const restocks = events.filter(e => e.type === EVENT_TYPES.RESTOCK);
    assert.strictEqual(restocks.length, 2, 'SKU-1 and SKU-3 should restock');
  });

  it('handles empty old products (all new)', () => {
    const newProducts = {};
    for (let i = 0; i < 50; i++) {
      newProducts[`SKU-${i}`] = makeProduct({ sku: `SKU-${i}` });
    }
    const events = diffProducts({}, newProducts);
    assert.strictEqual(events.length, 50);
  });

  it('handles empty new products (no events)', () => {
    const oldProducts = { 'SKU-1': makeProduct({ sku: 'SKU-1' }) };
    const events = diffProducts(oldProducts, {});
    assert.strictEqual(events.length, 0);
  });
});
