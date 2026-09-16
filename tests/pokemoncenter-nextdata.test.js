const { test, describe } = require('node:test');
const assert = require('node:assert');
const { pcProductsFromNextData, pcStockFromJson } = require('../src/adapters/pokemoncenter-nextdata');

/**
 * Captured verbatim from the live store: Probe 3, 2026-09-15, one load of
 * /en-ca/category/trading-card-game through the Railway residential exit. This is the first
 * element of $.props.initialState.search.results.products, logged by the probe's locateSku().
 *
 * Trimmed only where a field repeats itself (the second image, the price ranges); nothing that
 * the parser reads has been altered or invented.
 */
const REAL_PRODUCT = {
  brand: 'Pokémon Center',
  code: '10-10320-101',
  isMod: false,
  images: [{
    high: '',
    original: 'https://www.pokemoncenter.com/images/DAMRoot/Full-Size/10034/P11645_10-10320-101_01.jpg',
    thumbnail: 'https://www.pokemoncenter.com/images/DAMRoot/Thumbnail/10034/P11645_10-10320-101_01.jpg',
  }],
  lifestyleImages: { high: '', original: '', thumbnail: '' },
  listPrice: { amount: 53.99, display: '$53.99' },
  listPriceRange: { fromPrice: { amount: 53.99 }, toPrice: { amount: 53.99 } },
  name: 'Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder',
  outOfStock: false,
  prf: 'P11645',
  productDescription: '<p>Official Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder.</p>',
  purchasePrice: { amount: 53.99, display: '$53.99' },
  purchasePriceRange: { fromPrice: { amount: 53.99 }, toPrice: { amount: 53.99 } },
  releaseDate: '2026-07-08T00:00:00Z',
  reportingCrumb: 'TRADING CARD GAME>TCG Accessories>Binders',
  reportingName: 'Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder',
  url: '-',
};

const wrap = (products) => ({ props: { initialState: { search: { results: { products } } } } });

describe('pcProductsFromNextData — the real payload', () => {
  test('reads the product Probe 3 captured off the live grid', () => {
    const out = pcProductsFromNextData(wrap([REAL_PRODUCT]));
    assert.deepStrictEqual(out.products[0], {
      sku: '10-10320-101',
      name: 'Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder',
      price: 53.99,
      inStock: true,
      image: 'https://www.pokemoncenter.com/images/DAMRoot/Full-Size/10034/P11645_10-10320-101_01.jpg',
      releaseDate: '2026-07-08T00:00:00Z',
      breadcrumb: 'TRADING CARD GAME>TCG Accessories>Binders',
    });
  });

  test('accepts the raw script text, which is how the page hands it over', () => {
    const out = pcProductsFromNextData(JSON.stringify(wrap([REAL_PRODUCT])));
    assert.strictEqual(out.products.length, 1);
    assert.strictEqual(out.products[0].sku, '10-10320-101');
  });

  test('purchasePrice wins over listPrice — a sale is exactly when they diverge', () => {
    const onSale = { ...REAL_PRODUCT, purchasePrice: { amount: 39.99 }, listPrice: { amount: 53.99 } };
    assert.strictEqual(pcProductsFromNextData(wrap([onSale])).products[0].price, 39.99);
  });

  test('falls back to listPrice when purchasePrice carries no usable amount', () => {
    const noPurchase = { ...REAL_PRODUCT, purchasePrice: { display: '$53.99' } };
    assert.strictEqual(pcProductsFromNextData(wrap([noPurchase])).products[0].price, 53.99);
  });
});

describe('pcStockFromJson — strict, and refuses rather than guesses', () => {
  test('outOfStock false means in stock', () => {
    assert.strictEqual(pcStockFromJson({ outOfStock: false }), true);
  });

  test('outOfStock true means sold out', () => {
    assert.strictEqual(pcStockFromJson({ outOfStock: true }), false);
  });

  // The whole point of the rule. A renamed or dropped field must not read as availability, or the
  // first shape change fires a restock for the entire catalogue into the client's paid channel.
  test('a missing outOfStock refuses to answer — it does NOT mean in stock', () => {
    assert.strictEqual(pcStockFromJson({ code: '10-10320-101', name: 'x' }), null);
  });

  test('a truthy non-boolean refuses too — "false" the string is not false', () => {
    assert.strictEqual(pcStockFromJson({ outOfStock: 'false' }), null);
    assert.strictEqual(pcStockFromJson({ outOfStock: 0 }), null);
    assert.strictEqual(pcStockFromJson({ outOfStock: null }), null);
  });

  test('the refusal survives the full parse, as null on the row', () => {
    const noField = { ...REAL_PRODUCT };
    delete noField.outOfStock;
    assert.strictEqual(pcProductsFromNextData(wrap([noField])).products[0].inStock, null);
  });
});

describe('pcProductsFromNextData — an absent array is not an empty catalogue', () => {
  // Returning [] here would tell the caller the category is empty, and an empty category reads as
  // every product in it going out of stock at once.
  test('null when the measured path is missing entirely', () => {
    assert.strictEqual(pcProductsFromNextData({ props: {} }), null);
    assert.strictEqual(pcProductsFromNextData({}), null);
  });

  test('null when the page is not JSON at all — a block page, or hydration never ran', () => {
    assert.strictEqual(pcProductsFromNextData('<html>Pardon Our Interruption</html>'), null);
    assert.strictEqual(pcProductsFromNextData(''), null);
    assert.strictEqual(pcProductsFromNextData(null), null);
  });

  test('null when products sits there as something other than an array', () => {
    assert.strictEqual(pcProductsFromNextData(wrap({})), null);
    assert.strictEqual(pcProductsFromNextData(wrap(null)), null);
  });

  // Distinct from the above: the path IS there and IS an array, the store just has nothing in
  // this category. That is a real, reportable zero.
  test('a genuinely empty array reports an empty catalogue, not a failure', () => {
    const out = pcProductsFromNextData(wrap([]));
    assert.notStrictEqual(out, null);
    assert.deepStrictEqual(out.products, []);
  });
});

describe('pcProductsFromNextData — rows that cannot be identified are dropped', () => {
  test('no code means no row: nothing downstream could match it to a product', () => {
    const out = pcProductsFromNextData(wrap([{ name: 'Nameless', outOfStock: false }, REAL_PRODUCT]));
    assert.strictEqual(out.products.length, 1);
    assert.strictEqual(out.products[0].sku, '10-10320-101');
  });

  test('junk entries in the array do not take the whole page down with them', () => {
    const out = pcProductsFromNextData(wrap([null, 'nope', 42, REAL_PRODUCT]));
    assert.strictEqual(out.products.length, 1);
  });

  test('missing images and name degrade to empty, never to undefined', () => {
    const bare = { code: '10-99999-101', outOfStock: true };
    const row = pcProductsFromNextData(wrap([bare])).products[0];
    assert.strictEqual(row.image, '');
    assert.strictEqual(row.name, '');
    assert.strictEqual(row.price, null);
    assert.strictEqual(row.inStock, false);
  });
});

describe('pcProductsFromNextData — the grid, and only the grid', () => {
  /**
   * The reason this module exists. On the same load, the DOM extractor returned 33 anchors for
   * 31 products, because `a[href*="/en-ca/product/"]` also matches the mega-menu's own product
   * links. Those two — 716E11935 and 715E10557 — do not share the grid's SKU format and were
   * exactly the two tiles pcVerdict() had to refuse. The JSON array cannot contain them.
   */
  test('carries the grid count, with no mega-menu links mixed in', () => {
    const grid = Array.from({ length: 31 }, (_, i) => ({
      ...REAL_PRODUCT, code: `10-1${String(i).padStart(4, '0')}-101`,
    }));
    const out = pcProductsFromNextData(wrap(grid));
    assert.strictEqual(out.products.length, 31);
    assert.ok(out.products.every((p) => /^10-\d{5}-101$/.test(p.sku)));
    assert.ok(out.products.every((p) => p.inStock === true));
  });
});
