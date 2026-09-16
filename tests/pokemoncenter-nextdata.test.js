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

describe('a ROW-shape change must not read as an empty catalogue', () => {
  /**
   * The null-vs-[] contract guards the CONTAINER moving. It said nothing about the rows, and the
   * per-row drop defeated it silently: rename `code`, or ship it as a number, and 96 products
   * became `{products: []}` — the exact value this module promises never to produce for "could
   * not look", and the one that marks a live catalogue dead and then fires the whole restock wave
   * on recovery.
   */
  test('every row dropped returns null, NOT an empty catalogue', () => {
    const renamed = Array.from({ length: 96 }, (_, i) => ({ productCode: `10-1000${i}-101`, outOfStock: false }));
    assert.strictEqual(pcProductsFromNextData(wrap(renamed)), null);
  });

  test('a sku arriving as a number is a shape change, not 96 missing products', () => {
    const numeric = Array.from({ length: 96 }, (_, i) => ({ code: 1000 + i, outOfStock: false }));
    assert.strictEqual(pcProductsFromNextData(wrap(numeric)), null);
  });

  // A PARTIAL drop must stay visible rather than quietly shrinking the catalogue.
  test('a partial drop still parses, and reports how many rows it lost', () => {
    const out = pcProductsFromNextData(wrap([REAL_PRODUCT, { name: 'no code' }, { code: 42 }]));
    assert.strictEqual(out.products.length, 1);
    assert.strictEqual(out.dropped, 2);
  });

  test('a clean payload reports zero dropped', () => {
    assert.strictEqual(pcProductsFromNextData(wrap([REAL_PRODUCT])).dropped, 0);
  });
});

describe('duplicate skus are collapsed, and a contradiction refuses', () => {
  /**
   * The array is not guaranteed unique. Keeping the last silently picked a winner and made the
   * cross-check report a disagreement between the JSON and the tile that did not exist — feeding
   * a fabricated disagreement straight into the promotion decision.
   */
  test('the same sku twice yields one row', () => {
    const out = pcProductsFromNextData(wrap([
      { ...REAL_PRODUCT, code: 'A' }, { ...REAL_PRODUCT, code: 'A' }, { ...REAL_PRODUCT, code: 'B' },
    ]));
    assert.deepStrictEqual(out.products.map((p) => p.sku), ['A', 'B']);
  });

  test('copies that CONTRADICT each other on stock refuse rather than pick one', () => {
    const out = pcProductsFromNextData(wrap([
      { ...REAL_PRODUCT, code: 'A', outOfStock: false },
      { ...REAL_PRODUCT, code: 'A', outOfStock: true },
    ]));
    assert.strictEqual(out.products.length, 1);
    assert.strictEqual(out.products[0].inStock, null, 'an unresolvable sku must not be guessed');
  });

  test('copies that AGREE keep the verdict', () => {
    const out = pcProductsFromNextData(wrap([
      { ...REAL_PRODUCT, code: 'A', outOfStock: true }, { ...REAL_PRODUCT, code: 'A', outOfStock: true },
    ]));
    assert.strictEqual(out.products[0].inStock, false);
  });
});

describe('price — the shapes this store actually ships', () => {
  /**
   * Pokemon Center sells sized product; readOffers() elsewhere in the adapter exists precisely
   * because a Crocs clog ships as nine variants under one page. For those the flat price can be
   * absent while the range carries it, and ignoring the range wrote every sized product with a
   * null price.
   */
  test('falls back to purchasePriceRange.fromPrice when no flat price is present', () => {
    const ranged = {
      code: '70-11607', name: 'Crocs', outOfStock: false,
      purchasePriceRange: { fromPrice: { amount: 10.99 }, toPrice: { amount: 24.99 } },
    };
    assert.strictEqual(pcProductsFromNextData(wrap([ranged])).products[0].price, 10.99);
  });

  test('a flat price still wins over the range', () => {
    const both = {
      ...REAL_PRODUCT,
      purchasePriceRange: { fromPrice: { amount: 1.99 }, toPrice: { amount: 9.99 } },
    };
    assert.strictEqual(pcProductsFromNextData(wrap([both])).products[0].price, 53.99);
  });

  test('a numeric STRING amount is read rather than silently dropped', () => {
    const str = { code: 'A', outOfStock: false, purchasePrice: { amount: '53.99' } };
    assert.strictEqual(pcProductsFromNextData(wrap([str])).products[0].price, 53.99);
  });

  test('a junk amount yields no price rather than a wrong one', () => {
    const junk = { code: 'A', outOfStock: false, purchasePrice: { amount: 'free' } };
    assert.strictEqual(pcProductsFromNextData(wrap([junk])).products[0].price, null);
  });
});
