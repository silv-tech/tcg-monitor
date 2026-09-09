/**
 * An alert's name, image and link must describe the same product.
 *
 * Reported 2026-09-08: an #amazon-canada alert showed "Pokemon TCG: Mega Evolution - Chaos
 * Rising Sleeved Booster" with a matching image and ASIN B0BCC6N8YL, but amazon.ca/dp/
 * B0BCC6N8YL serves a PopSockets phone grip. Verified live the same day — both the product
 * page and the AOD fragment return "PopSockets Phone Grip with Expanding Kickstand, Adhesive
 * Grip, Pokemon, Cute PopSockets - Bulbasaur Terrarium".
 *
 * The search parser was not at fault: run against live search HTML for the production
 * queries it paired all 90 cards correctly and never produced B0BCC6N8YL at all. The fault
 * was that _monitorKnownAsins fetched the live title on every poll and threw it away —
 * "keep cached identity, update price + stock only" — so the name and image were frozen at
 * whatever discovery first stored, while the link followed the ASIN to whatever Amazon
 * served today. The out-of-scope purge that should have caught it rejects the live title
 * (isInScopeName is false) but was reading the same stale name.
 *
 * A wrong field is worse than a missing one, so this drives the real _monitorKnownAsins
 * rather than a mirror of it.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const state = require('../src/core/state');
// The identity denylist is Redis-backed, and state.js calls its own internal getRedis(), so a
// real connection opens unless the exported functions are stubbed — an open socket keeps the
// test process alive after every assertion has passed.
state.getDeniedIdentities = async () => new Map();
state.denyIdentity = async () => {};


// The AOD path caches offer ids and sellers into Redis as a side effect.
state.cacheOfferListingId = async () => {};
state.cacheSellerInfo = async () => {};

// The exact strings involved in the incident, captured live on 2026-09-08.
const LIVE_POPSOCKET = 'PopSockets Phone Grip with Expanding Kickstand, Adhesive Grip, Pokemon, Cute PopSockets - Bulbasaur Terrarium';
const STALE_BOOSTER = 'Pokemon TCG: Mega Evolution - Chaos Rising Sleeved Booster';

function adapter() {
  return new AmazonAdapter({ id: 'amazon', name: 'Amazon', url: 'https://www.amazon.ca' });
}

// Seed one ASIN and answer its AOD check with `aod`. Returns the products map the poll built.
async function pollOne(asin, cached, aod) {
  const a = adapter();
  a._knownProducts.set(asin, cached);
  a._stealthCheckAsin = async () => (aod === null ? null : { asin, ...aod });
  const products = { [asin]: cached };
  await a._monitorKnownAsins(products);
  return { a, products };
}

describe('amazon: a repurposed listing cannot keep alerting under its old name', () => {
  test('the reported ASIN is dropped once the live title is read', async () => {
    const cached = {
      sku: 'B0BCC6N8YL', name: STALE_BOOSTER, category: 'pokemon',
      price: 18.47, inStock: true, image: 'https://m.media-amazon.com/booster.jpg',
    };
    const { a, products } = await pollOne('B0BCC6N8YL', cached, {
      name: LIVE_POPSOCKET, price: 9.99, inStock: true, image: 'https://m.media-amazon.com/grip.jpg',
    });

    assert.ok(!('B0BCC6N8YL' in products), 'must not be reported as a product this poll');
    assert.ok(!a._knownProducts.has('B0BCC6N8YL'), 'must not be re-checked on the next poll');
  });

  test('a relist that stays in scope adopts the live name instead of alerting on the old one', async () => {
    const cached = {
      sku: 'B0GR6Q72ND', name: 'Pokémon TCG: Mega Evolution—Chaos Rising Booster Bundle',
      category: 'pokemon', price: 39.92, inStock: false, image: 'old.jpg',
    };
    const live = 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    const { a, products } = await pollOne('B0GR6Q72ND', cached, {
      name: live, price: 71.04, inStock: true, image: 'new.jpg',
    });

    assert.strictEqual(products.B0GR6Q72ND.name, live, 'the name must follow the ASIN');
    assert.strictEqual(a._knownProducts.get('B0GR6Q72ND').name, live);
    assert.strictEqual(products.B0GR6Q72ND.category, 'pokemon');
  });
});

describe('amazon: the same product is not mistaken for a relist', () => {
  test("the aria-label's dropped brand prefix does not rename anything", async () => {
    // What search stores vs what AOD returns for one and the same listing.
    const cached = { sku: 'B0GYVHLP4L', name: 'TCG: Mega Evolution—Pitch Black Elite Trainer Box', category: 'pokemon', price: 0, inStock: false, image: 'a.jpg' };
    const { products } = await pollOne('B0GYVHLP4L', cached, {
      name: 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box', price: 129.98, inStock: true, image: 'a.jpg',
    });
    assert.strictEqual(products.B0GYVHLP4L.name, cached.name, 'a fuller rendering is not a relist');
  });

  test('punctuation and zero-width padding do not rename anything', async () => {
    const cached = { sku: 'B0GFZV1ZVV', name: 'Pokemon TCG: Mega Evolution - Perfect Order Elite Trainer Box', category: 'pokemon', price: 129.98, inStock: true, image: 'a.jpg' };
    const { products } = await pollOne('B0GFZV1ZVV', cached, {
      // AOD serves this title with leading zero-width spaces, an em dash and an accent.
      name: '​​Pokémon TCG: Mega Evolution—Perfect Order Elite Trainer Box',
      price: 129.98, inStock: true, image: 'a.jpg',
    });
    assert.strictEqual(products.B0GFZV1ZVV.name, cached.name);
  });

  test('an AOD fragment with no title leaves the identity alone', async () => {
    const cached = { sku: 'B0GR6N18F6', name: 'Pokémon TCG: Mega Evolution—Chaos Rising Elite Trainer Box', category: 'pokemon', price: 100, inStock: false, image: 'a.jpg' };
    const { a, products } = await pollOne('B0GR6N18F6', cached, {
      name: null, price: 149.99, inStock: true, image: '',
    });
    assert.strictEqual(products.B0GR6N18F6.name, cached.name);
    assert.ok(a._knownProducts.has('B0GR6N18F6'), 'a missing title is not evidence of anything');
  });
});

describe('amazon: price and stock still come from the live offer', () => {
  test('an in-scope product updates price, stock and image as before', async () => {
    const cached = { sku: 'B0GXJ8CSTY', name: 'Pokémon TCG: Mega Greninja ex Premium Collection', category: 'pokemon', price: 69.65, inStock: false, image: 'old.jpg' };
    const { products } = await pollOne('B0GXJ8CSTY', cached, {
      name: 'Pokémon TCG: Mega Greninja ex Premium Collection', price: 59.99, inStock: true, image: 'new.jpg',
    });
    const p = products.B0GXJ8CSTY;
    assert.strictEqual(p.price, 59.99);
    assert.strictEqual(p.inStock, true);
    assert.strictEqual(p.canAddToCart, true);
    assert.strictEqual(p.image, 'new.jpg');
  });

  test('a failed fetch still returns the cached product unchanged', async () => {
    const cached = { sku: 'B0GXJ8CSTY', name: 'Pokémon TCG: Mega Greninja ex Premium Collection', category: 'pokemon', price: 69.65, inStock: true, image: 'old.jpg' };
    const { a, products } = await pollOne('B0GXJ8CSTY', cached, null);
    assert.strictEqual(products.B0GXJ8CSTY, cached, 'no false OOS');
    assert.ok(a._knownProducts.has('B0GXJ8CSTY'));
  });
});
