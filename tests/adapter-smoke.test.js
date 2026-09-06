/**
 * Actually CALL fetchProducts().
 *
 * A refactor moved Pokemon Center's paid checks off the poll path and left four references to
 * a `batchSize` variable that no longer existed. Every poll threw "batchSize is not defined",
 * the store logged 25 consecutive errors and went stale — and 539 tests passed the whole
 * time, because not one of them ever invoked fetchProducts. The bug was caught in production
 * by the still-down reminder, which is far too late for something a single call would expose.
 *
 * These are deliberately shallow. Network, Redis and the paid checker are all stubbed, so
 * nothing here asserts business logic — the parsing and scope suites do that. The only claim
 * is that the poll path can be executed without throwing, which is exactly the class of
 * mistake that shipped.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;
const cfgFor = (id) => list.find((r) => r.id === id);

describe('adapter smoke: fetchProducts runs without throwing', () => {
  test('pokemon center completes a poll and returns its catalogue', async () => {
    const PokemonCenter = require('../src/adapters/pokemoncenter');
    const a = new PokemonCenter(cfgFor('pokemoncenter'));

    // Stub every outbound edge: this is a wiring check, not a network test.
    a.scanSitemap = async () => {};
    a._loadAvailability = async () => {};
    a._loadUnfetchable = async () => {};
    a._saveAvailability = async () => {};
    a._saveUnfetchable = async () => {};
    a._selectCheckTargets = () => [];
    a.sitemapProducts = new Map([
      ['10-10451-115', { url: 'https://www.pokemoncenter.com/en-ca/product/10-10451-115/x', name: 'Pokemon TCG Booster Bundle' }],
      ['10-10425-120', { url: 'https://www.pokemoncenter.com/en-ca/product/10-10425-120/y', name: 'Pokemon TCG Elite Trainer Box' }],
    ]);

    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 2);
    const first = products['10-10451-115'];
    assert.strictEqual(first.retailerId, 'pokemoncenter');
    assert.strictEqual(first.currency, 'CAD');
    // No availability known yet, so it must report not-in-stock rather than inventing one.
    assert.strictEqual(first.inStock, false);
    assert.strictEqual(first.price, null);
  });

  test('pokemon center reflects cached availability once it exists', async () => {
    const PokemonCenter = require('../src/adapters/pokemoncenter');
    const a = new PokemonCenter(cfgFor('pokemoncenter'));
    a.scanSitemap = async () => {};
    a._loadAvailability = async () => {};
    a._loadUnfetchable = async () => {};
    a._saveAvailability = async () => {};
    a._saveUnfetchable = async () => {};
    a._selectCheckTargets = () => [];
    a.sitemapProducts = new Map([['sku1', { url: 'https://x/product/sku1/n', name: 'Pokemon TCG Booster Box' }]]);
    a.availabilityCache = new Map([['sku1', { inStock: true, price: 36.99, image: 'img' }]]);

    const products = await a.fetchProducts();
    assert.strictEqual(products.sku1.inStock, true);
    assert.strictEqual(products.sku1.price, 36.99);
    assert.strictEqual(products.sku1.canAddToCart, true);
  });

  test('an empty sitemap raises the intended guard, not a stray ReferenceError', async () => {
    // Throwing here is correct: an empty sitemap means the free discovery leg failed, and
    // returning {} would silently mark the whole catalogue out of stock. The point of this
    // test is that the message is the DELIBERATE guard rather than a wiring mistake.
    const PokemonCenter = require('../src/adapters/pokemoncenter');
    const a = new PokemonCenter(cfgFor('pokemoncenter'));
    a.scanSitemap = async () => {};
    a._loadAvailability = async () => {};
    a._loadUnfetchable = async () => {};
    a._selectCheckTargets = () => [];
    a.sitemapProducts = new Map();
    await assert.rejects(() => a.fetchProducts(), /No TCG products in sitemap cache/);
  });
});

describe('adapter smoke: every adapter can be constructed from its real config', () => {
  // Cheap, but it catches a broken import or a constructor that throws on live config —
  // which is otherwise only discovered at boot in production.
  const cases = [
    ['pokemoncenter', '../src/adapters/pokemoncenter'],
    ['ebgames', '../src/adapters/ebgames'],
    ['walmart', '../src/adapters/walmart'],
    ['amazon', '../src/adapters/amazon'],
    ['bestbuy', '../src/adapters/bestbuy'],
    ['costco', '../src/adapters/costco'],
    ['londondrugs', '../src/adapters/londondrugs'],
  ];
  for (const [id, mod] of cases) {
    test(id + ' constructs', () => {
      const Adapter = require(mod);
      const cfg = cfgFor(id);
      assert.ok(cfg, id + ' must exist in retailers.json');
      const a = new Adapter(cfg);
      assert.strictEqual(a.id, id);
      assert.strictEqual(typeof a.fetchProducts, 'function');
    });
  }

  test('every shop in retailers.json maps to an adapter that exists', () => {
    const ADAPTERS = ['ebgames', 'costco', 'pokemoncenter', 'walmart', 'amazon', 'shopify', 'bestbuy', 'londondrugs'];
    for (const r of list) {
      if (!r.enabled) continue;
      assert.ok(ADAPTERS.includes(r.adapter), `${r.id} uses unknown adapter "${r.adapter}"`);
    }
  });
});
