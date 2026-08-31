const assert = require('assert');
const { describe, it } = require('node:test');
const { EVENT_TYPES, diffProducts } = require('../src/core/events');
const { buildEmbed } = require('../src/discord/embeds');

function makeProduct(sku, overrides = {}) {
  return {
    sku,
    name: `Test Product ${sku}`,
    price: 49.99 + Math.random() * 200,
    currency: 'CAD',
    url: `https://teststore.ca/products/${sku}`,
    image: `https://teststore.ca/img/${sku}.jpg`,
    retailer: overrides.retailer || 'Test Store',
    inStock: true,
    canAddToCart: true,
    category: 'pokemon',
    productType: 'booster-box',
    lastSeen: Date.now(),
    shipsToHome: true,
    ...overrides,
  };
}

describe('E2E Simulation: 50 SKUs go live', () => {
  it('detects 50 NEW_SKU events when all are new', () => {
    const newProducts = {};
    for (let i = 1; i <= 50; i++) {
      newProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`);
    }
    const events = diffProducts({}, newProducts);
    assert.strictEqual(events.length, 50);
    assert.ok(events.every(e => e.type === EVENT_TYPES.NEW_SKU));
  });

  it('detects 50 RESTOCK events when all go from OOS to in-stock', () => {
    const oldProducts = {};
    const newProducts = {};
    for (let i = 1; i <= 50; i++) {
      oldProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`, { inStock: false, canAddToCart: false });
      newProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`, { inStock: true, canAddToCart: true });
    }
    const events = diffProducts(oldProducts, newProducts);
    const restocks = events.filter(e => e.type === EVENT_TYPES.RESTOCK);
    const cartEvents = events.filter(e => e.type === EVENT_TYPES.CART_AVAILABLE);
    assert.strictEqual(restocks.length, 50);
    assert.strictEqual(cartEvents.length, 50);
  });

  it('handles mixed events across 50 SKUs', () => {
    const oldProducts = {};
    const newProducts = {};
    for (let i = 1; i <= 50; i++) {
      if (i <= 20) {
        // Restocks — both inStock and canAddToCart flip, so RESTOCK + CART_AVAILABLE
        // Use fixed price so no PRICE_CHANGE fires for these
        oldProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`, { inStock: false, canAddToCart: false, price: 99.99 });
        newProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`, { inStock: true, canAddToCart: true, price: 99.99 });
      } else if (i <= 30) {
        // Price drops only — stock unchanged
        oldProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`, { price: 200 });
        newProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`, { price: 150 });
      } else if (i <= 40) {
        // New SKUs
        newProducts[`SKU-${i}`] = makeProduct(`SKU-${i}`);
      } else {
        // No change
        const prod = makeProduct(`SKU-${i}`);
        oldProducts[`SKU-${i}`] = prod;
        newProducts[`SKU-${i}`] = { ...prod };
      }
    }
    const events = diffProducts(oldProducts, newProducts);
    const restocks = events.filter(e => e.type === EVENT_TYPES.RESTOCK);
    const cartEvents = events.filter(e => e.type === EVENT_TYPES.CART_AVAILABLE);
    const priceChanges = events.filter(e => e.type === EVENT_TYPES.PRICE_CHANGE);
    const newSkus = events.filter(e => e.type === EVENT_TYPES.NEW_SKU);
    assert.strictEqual(restocks.length, 20);
    assert.strictEqual(cartEvents.length, 20); // canAddToCart also flips
    assert.strictEqual(priceChanges.length, 10);
    assert.strictEqual(newSkus.length, 10);
  });

  it('builds valid embeds for all event types', () => {
    const product = makeProduct('EMBED-TEST', {
      retailer: 'Best Buy Canada',
      price: 199.99,
    });

    const eventTypes = [
      { type: EVENT_TYPES.RESTOCK, product, detail: 'Back in stock' },
      { type: EVENT_TYPES.NEW_SKU, product, detail: 'New product' },
      { type: EVENT_TYPES.PRICE_CHANGE, product, detail: 'Price dropped', oldValue: 249.99, newValue: 199.99 },
      { type: EVENT_TYPES.CART_AVAILABLE, product, detail: 'Cart now available' },
      { type: EVENT_TYPES.SHIPPING_CHANGE, product, detail: 'Ships to home' },
    ];

    for (const event of eventTypes) {
      const embed = buildEmbed(event);
      assert.ok(embed, `Embed should be created for ${event.type}`);
      const json = embed.toJSON();
      assert.ok(json.title, `Embed should have title for ${event.type}`);
      assert.ok(json.description, `Embed should have description for ${event.type}`);
      assert.ok(json.description, `Embed should have description for ${event.type}`);
    }
  });

  it('embed price change shows old/new values', () => {
    const product = makeProduct('PRICE-TEST', { price: 149.99, retailer: 'Walmart Canada' });
    const event = {
      type: EVENT_TYPES.PRICE_CHANGE,
      product,
      detail: 'Price dropped 25.0%',
      oldValue: 199.99,
      newValue: 149.99,
    };
    const embed = buildEmbed(event);
    const json = embed.toJSON();
    // Price info is now in the description line
    assert.ok(json.description.includes('199.99'), 'Should show old price');
    assert.ok(json.description.includes('149.99'), 'Should show new price');
  });

  it('handles high volume without errors', () => {
    const oldProducts = {};
    const newProducts = {};
    // 500 products, half restocking
    for (let i = 0; i < 500; i++) {
      const sku = `BULK-${i.toString().padStart(4, '0')}`;
      oldProducts[sku] = makeProduct(sku, { inStock: i % 2 === 0 });
      newProducts[sku] = makeProduct(sku, { inStock: true });
    }
    const start = Date.now();
    const events = diffProducts(oldProducts, newProducts);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Should process 500 products in <1s, took ${elapsed}ms`);
    const restocks = events.filter(e => e.type === EVENT_TYPES.RESTOCK);
    assert.strictEqual(restocks.length, 250);
  });
});

describe('Shopify adapter unit tests', () => {
  it('classifies pokemon products correctly', () => {
    const { classifyCategory } = require('../src/utils/helpers');
    const categories = require('../src/config/products.json').categories;

    const tests = [
      ['Pokemon Scarlet & Violet Booster Box', 'pokemon'],
      ['One Piece OP-17 Booster Box', 'onepiece'],
      ['Dragon Ball Super Card Game Booster', 'dragonball'],
      ['Disney Lorcana Rise of the Floodborn', 'lorcana'],
      ['Random Board Game', 'other'],
    ];

    for (const [name, expected] of tests) {
      assert.strictEqual(classifyCategory(name, categories), expected, `"${name}" should be ${expected}`);
    }
  });
});
