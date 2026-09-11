/**
 * Pokemon Center serves TWO schema.org offer shapes, and reading only one of them is wrong.
 *
 *   Offer           a single item      { "@type":"Offer", availability, price }
 *   AggregateOffer  anything SIZED     { "@type":"AggregateOffer", lowPrice, offerCount,
 *                                        offers:[ {sku, availability, price} ] }
 *
 * Measured against the live store 2026-09-11. The TCG zip binder 10-10320-101 is the first
 * shape. The Crocs clog 70-11607 is the second — nine size variants, four InStock, three
 * OutOfStock, and NO top-level `availability` at all.
 *
 * The reader looked only for `offers.availability`, so every clothing and footwear product read
 * as out of stock with no price. While the catalogue was TCG-only that was invisible; the moment
 * it widened, twenty perfectly healthy 447KB pages produced nothing at all.
 *
 * A sized product is IN STOCK if ANY size is — the honest answer for a stock monitor, because
 * somebody can buy it. Price comes from lowPrice, which is the figure the shopper is shown.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const PokemonCenterAdapter = require('../src/adapters/pokemoncenter');

const adapter = () => new PokemonCenterAdapter({
  id: 'pokemoncenter', name: 'Pokemon Center',
  url: 'https://www.pokemoncenter.com', intervalMs: 8000,
});

const wrap = (j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`;

// The TCG shape.
const SINGLE = {
  '@type': 'Product', sku: '10-10320-101',
  name: 'Pokemon TCG: Mewtwo & Mew DNA Premium Zip Binder',
  image: ['https://www.pokemoncenter.com/images/a_01.jpg', 'https://www.pokemoncenter.com/images/a_02.jpg'],
  offers: { '@type': 'Offer', availability: 'http://schema.org/InStock', price: 53.99, priceCurrency: 'CAD' },
};

// The Crocs clog 70-11607, exactly as served.
const sized = (availabilities) => ({
  '@type': 'Product', mpn: '70-11607', name: 'Poke Ball Classic Clog By Crocs Kids',
  offers: {
    '@type': 'AggregateOffer', lowPrice: 74.99, highPrice: 74.99,
    offerCount: availabilities.length, priceCurrency: 'CAD',
    offers: availabilities.map((a, i) => ({
      '@type': 'Offer', sku: `70-11607-10${i}`, price: 74.99,
      availability: `http://schema.org/${a}`,
    })),
  },
});

describe('the single-Offer shape', () => {
  test('in stock, with its price', () => {
    const got = adapter().parseJsonLd(wrap(SINGLE));
    assert.strictEqual(got.inStock, true);
    assert.strictEqual(got.price, 53.99);
  });

  test('out of stock keeps its price — the alert needs it', () => {
    const oos = { ...SINGLE, offers: { ...SINGLE.offers, availability: 'http://schema.org/OutOfStock' } };
    const got = adapter().parseJsonLd(wrap(oos));
    assert.strictEqual(got.inStock, false);
    assert.strictEqual(got.price, 53.99);
  });
});

describe('the AggregateOffer shape, which products with SIZES use', () => {
  test('one size in stock means the product is in stock', () => {
    const got = adapter().parseJsonLd(wrap(sized(['OutOfStock', 'OutOfStock', 'InStock'])));
    assert.strictEqual(got.inStock, true, 'somebody can buy it, so it is in stock');
    assert.strictEqual(got.price, 74.99, 'lowPrice is what the shopper sees');
  });

  test('every size gone means out of stock', () => {
    const got = adapter().parseJsonLd(wrap(sized(['OutOfStock', 'OutOfStock', 'OutOfStock'])));
    assert.strictEqual(got.inStock, false);
    assert.strictEqual(got.price, 74.99);
  });

  test('the nine-variant page measured on the live store reads in stock', () => {
    const real = sized(['InStock', 'InStock', 'InStock', 'OutOfStock', 'OutOfStock',
      'OutOfStock', 'InStock', 'InStock', 'InStock']);
    const got = adapter().parseJsonLd(wrap(real));
    assert.strictEqual(got.inStock, true);
  });

  test('an empty variant list is not silently in stock', () => {
    const empty = { '@type': 'Product', mpn: 'X', offers: { '@type': 'AggregateOffer', lowPrice: 10, offers: [] } };
    const got = adapter().parseJsonLd(wrap(empty));
    assert.strictEqual(got.inStock, false);
  });
});

describe('shapes that must not crash or invent stock', () => {
  test('no offers at all', () => {
    const got = adapter().parseJsonLd(wrap({ '@type': 'Product', sku: 'X', name: 'Y' }));
    assert.strictEqual(got.inStock, false);
    assert.strictEqual(got.price, null);
  });

  test('an ARRAY of offers is read too', () => {
    const arr = { '@type': 'Product', sku: 'X', offers: [
      { '@type': 'Offer', availability: 'http://schema.org/OutOfStock', price: 20 },
      { '@type': 'Offer', availability: 'http://schema.org/InStock', price: 15 },
    ] };
    const got = adapter().parseJsonLd(wrap(arr));
    assert.strictEqual(got.inStock, true);
    assert.strictEqual(got.price, 15, 'the cheapest real price wins');
  });

  test('malformed JSON-LD returns null rather than throwing', () => {
    assert.doesNotThrow(() => adapter().parseJsonLd('<script type="application/ld+json">{ nope </script>'));
  });
});

describe('the image array that used to lose alerts permanently', () => {
  test('a gallery array is reduced to the primary shot', () => {
    // PC ships `image` as 5+ URLs. Stored raw it reaches embeds.setThumbnail(), which THROWS on
    // an array — inside buildAlertEmbed, after the new stock state is already written, so the
    // transition can never re-fire and the alert is lost for good.
    const got = adapter().parseJsonLd(wrap(SINGLE));
    assert.strictEqual(typeof got.image, 'string');
    assert.strictEqual(got.image, 'https://www.pokemoncenter.com/images/a_01.jpg');
  });
});
