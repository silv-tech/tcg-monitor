/**
 * London Drugs parses stock out of a Next.js RSC flight payload, so the tests here guard
 * the two things that actually break alerts:
 *
 *   1. The scope filter. The trading-cards category also holds Funko POPs, hockey blasters
 *      and Pokemon-branded binders. Costco shipped MTG tins and a $7,299 pinball machine
 *      before its filter split game name from product form; this uses the same split, plus
 *      an accessory exclusion because "Ultra PRO Pokemon Trading Card Book" satisfies both.
 *
 *   2. The flight parser. It is reference-based ("$2c52" pointers into other rows), so an
 *      unresolved price silently becomes the string "$2c52" rather than a number — which
 *      would put a garbage price in an embed. A wrong field is worse than a missing one.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseFlightProducts,
  isTrackedCardProduct,
  slugMap,
  decodeEntities,
} = require('../src/adapters/londondrugs');

// Shaped exactly like the live payload: rows are "<hexid>:<json>", values may be "$<hexid>".
function flightHtml(rows) {
  const payload = rows.map(([id, obj]) => `${id}:${JSON.stringify(obj)}`).join('\n');
  return `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
}

describe('londondrugs: scope filter keeps the wrong products out', () => {
  const rejected = [
    'Funko POP! Spider-Man - Black/Gold',
    '2024-25 NHL Upper Deck MVP Hockey Blaster Box',
    'Topps 2023 MLB Heritage Fat Pack',
    'Yu-Gi-Oh! Trading Card Game: Masquerena Card Case',
    'Ultra PRO Frosted Forest Standard Deck Protector Sleeves',
    'Pocket Pages - 30 pack',
  ];
  for (const name of rejected) {
    test(`rejects ${name}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), false);
    });
  }

  const accessories = [
    'Ultra PRO Pokemon Trading Card Book - Sword and Shield - 252 Cards',
    'Ultra PRO Pokemon Scarlet and Violet 9 Trading Card Book - 9 Pocket Portfolio',
    'Pokemon Trading Card Game Mini Portfolio',
  ];
  for (const name of accessories) {
    test(`rejects Pokemon-branded accessory: ${name.slice(0, 44)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), false);
    });
  }

  const accepted = [
    "Pokemon TCG: Team Rocket's Mewtwo ex League Battle Deck Booster Box",
    'Pokemon TCG: Mega Evolution Ascended Heroes Elite Trainer Box',
    'Pokemon TCG: Mega Evolution Pitch Black Booster Bundle',
    'Pokemon TCG: Mega Evolution Chaos Rising Checklane Blister Pack',
    'Pokemon Trading Card Game: Lumiose City Mini Tin',
    'Pokemon TCG: Charizard ex Ultra Premium Collection Booster Bundle',
    'Pokemon TCG: Mega Evolution Phantasmal Flames Build & Battle Box',
  ];
  for (const name of accepted) {
    test(`accepts ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), true);
    });
  }

  test('a One Piece sealed product would be picked up if London Drugs ever lists one', () => {
    // The store carries none today — verified against all 29,775 products in its sitemap.
    assert.strictEqual(isTrackedCardProduct('One Piece Card Game: Romance Dawn Booster Box'), true);
  });
});

describe('londondrugs: flight payload parser', () => {
  test('resolves $-references into real price and fulfilment values', () => {
    const html = flightHtml([
      ['2c50', ['InStorePickup']],
      ['2c52', { price: 24.99, salePrice: null, listPrice: 24.99 }],
      ['2c4f', {
        productCode: 'L3408395',
        supportedFulfilmentTypes: '$2c50',
        isAvailable: true,
        inventory: { onlineStockLevel: 2 },
        productName: 'Pokemon TCG: Mega Evolution Pitch Black Booster Bundle',
        price: '$2c52',
        maxOrderableQuantity: 1,
      }],
    ]);

    const products = parseFlightProducts(html);
    assert.strictEqual(products.length, 1);
    const p = products[0];
    assert.strictEqual(p.productCode, 'L3408395');
    assert.deepStrictEqual(p.supportedFulfilmentTypes, ['InStorePickup']);
    assert.strictEqual(typeof p.price.listPrice, 'number');
    assert.strictEqual(p.price.listPrice, 24.99);
    assert.strictEqual(p.inventory.onlineStockLevel, 2);
  });

  test('an unresolved reference never leaks a "$hex" string into a price', () => {
    const html = flightHtml([
      ['2c4f', {
        productCode: 'L1',
        isAvailable: true,
        productName: 'Pokemon TCG: Booster Bundle',
        price: '$deadbe', // pointer to a row that never arrived
      }],
    ]);
    const p = parseFlightProducts(html)[0];
    // It stays a string here, which is exactly why the adapter coerces with Number() and
    // the live test asserts every price is a positive number.
    assert.strictEqual(Number(p.price) || 0, 0);
  });

  test('$undefined becomes undefined rather than the literal string', () => {
    const html = flightHtml([
      ['2c4f', { productCode: 'L2', isAvailable: false, productName: 'Pokemon TCG Tin', brand: '$undefined' }],
    ]);
    assert.strictEqual(parseFlightProducts(html)[0].brand, undefined);
  });

  test('a reference cycle terminates instead of hanging the poll', () => {
    const html = flightHtml([
      ['aa', { self: '$bb' }],
      ['bb', { back: '$aa' }],
      ['2c4f', { productCode: 'L3', isAvailable: true, productName: 'Pokemon TCG Booster Box', loop: '$aa' }],
    ]);
    const products = parseFlightProducts(html);
    assert.strictEqual(products.length, 1);
    assert.strictEqual(products[0].productCode, 'L3');
  });

  test('duplicate product rows collapse to one entry', () => {
    const row = { productCode: 'L4', isAvailable: true, productName: 'Pokemon TCG Booster Box' };
    const html = flightHtml([['a1', row], ['a2', row]]);
    assert.strictEqual(parseFlightProducts(html).length, 1);
  });

  test('rows that are not products are ignored', () => {
    const html = flightHtml([
      ['b1', { categoryId: 8805, name: '', categoryCode: '8805' }],
      ['b2', { productCode: 'L5' }], // no isAvailable — not a product row
    ]);
    assert.strictEqual(parseFlightProducts(html).length, 0);
  });

  test('malformed HTML yields no products instead of throwing', () => {
    assert.deepStrictEqual(parseFlightProducts('<html>blocked</html>'), []);
    assert.deepStrictEqual(parseFlightProducts(''), []);
  });
});

describe('londondrugs: product URL recovery', () => {
  test('slugs are recovered from the surrounding HTML', () => {
    const html = '<a href="/products/pokemon-tcg-mega-evolution-ascended-heroes-elite-trainer-box/p/L3310122">x</a>';
    assert.strictEqual(
      slugMap(html).get('L3310122'),
      'pokemon-tcg-mega-evolution-ascended-heroes-elite-trainer-box'
    );
  });

  test('the first slug wins when a code appears more than once', () => {
    const html = '<a href="/products/first-slug/p/L1">a</a><a href="/products/second-slug/p/L1">b</a>';
    assert.strictEqual(slugMap(html).get('L1'), 'first-slug');
  });
});

describe('londondrugs: name decoding', () => {
  test('HTML entities are decoded so embeds do not show &amp;', () => {
    assert.strictEqual(
      decodeEntities('Pokemon TCG: Mega Evolution Pitch Black Build &amp; Battle Box'),
      'Pokemon TCG: Mega Evolution Pitch Black Build & Battle Box'
    );
  });

  test('a decoded name still passes the scope filter', () => {
    const name = decodeEntities('Pokemon TCG: Phantasmal Flames Build &amp; Battle Box');
    assert.strictEqual(isTrackedCardProduct(name), true);
  });
});

/**
 * A sealed product form must beat the accessory exclusion.
 *
 * "Sleeved Booster Pack" is a booster pack — sealed cards, the exact thing people wait for —
 * but "sleeved" matched the card-sleeves exclusion and removed it silently. London Drugs
 * listed four of them and this monitor tracked none, which only surfaced when the client asked
 * whether all Pokemon TCG stock was covered.
 *
 * The general lesson is the one the shops' non-TCG filter already records: an exclusion list is
 * a heuristic over words in a title, and letting it veto an actual product form is how real
 * stock goes missing. A missed drop is the failure that matters; a junk alert is not.
 */
describe('londondrugs: a sealed form outranks the accessory list', () => {
  const tracked = [
    'Pokemon TCG: Mega Evolution Chaos Rising Sleeved Booster Pack',
    'Pokemon TCG: Mega Evolution Perfect Order Sleeved Booster Pack',
    'Pokemon TCG: Mega Evolution Sleeved Booster Pack - Assorted',
    'Pokemon Trading Card Game: Scarlet & Violet 10 Destined Rivals Sleeved Booster Pack',
  ];
  for (const name of tracked) {
    test(`tracks: ${name.slice(0, 52)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), true,
        'a sleeved booster pack is sealed product, not sleeves');
    });
  }

  // The rescue must not become a hole: these still have to stay out.
  const excluded = [
    'Ultra PRO Pokemon Card Sleeves - 100 pack',
    'Ultra PRO Pokemon Trading Card Book - Sword and Shield - 252 cards',
    'Pokemon Trading Card Game: Mini Portfolio',
    'Mattel Mega Pokemon Evergreen Pokeball - Assorted',
    'Jazwares Pokemon Battle Figure',
  ];
  for (const name of excluded) {
    test(`still excludes: ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), false);
    });
  }
});
