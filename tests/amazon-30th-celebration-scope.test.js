/**
 * Amazon: the 30th-anniversary line must survive the game-name gate even when Amazon strips
 * the "Pokémon" prefix from the search tile.
 *
 * Root cause (verified live 2026-09-09 + by the scope audit): Amazon's search aria-label renders
 * "Pokémon TCG: 30th Celebration Elite Trainer Box" as "TCG: 30th Celebration Elite Trainer Box"
 * — no franchise word. The discovery paths (_buildFromSearch, fetchProductPage, _processSearchItems)
 * gated on GAME_NAMES ONLY, and "30th Celebration" was not a known SET_NAME, so these products
 * were dropped whenever the image-alt restore of "Pokémon" failed. ASINs actually missed:
 * B0H7818RCM ($39.99), B0H78BB9TY ($89.99). Fix: recognise the set name as game scope.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const { isInScopeName } = require('../src/utils/scope');

function adapter() {
  return new AmazonAdapter({ id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000, proxyTier: 'none' });
}
function item(name, over = {}) {
  return { asin: 'B0TEST', name, price: 89.99, inStock: true, image: 'https://m.media-amazon.com/x.jpg', _alt: '', ...over };
}

// The two titles as Amazon's tile actually renders them — "Pokémon" prefix STRIPPED, no _alt.
const ETB_STRIPPED = 'TCG: 30th Celebration Elite Trainer Box';
const TIN_STRIPPED = 'TCG: 30TH Celebration (Sylveon EX o Greninja EX SE ENVÍA Aleatorio)';
const ETB_FULL = 'Pokémon TCG: 30th Celebration Elite Trainer Box';

describe('amazon 30th-celebration scope fix', () => {
  test('BEFORE-fix failure mode is now fixed: stripped ETB title builds a product', () => {
    const p = adapter()._buildFromSearch(item(ETB_STRIPPED), 'pokemon 30th celebration');
    assert.ok(p, 'stripped "30th Celebration ETB" must NOT be dropped anymore');
    assert.strictEqual(p.sku, 'B0TEST');
    assert.strictEqual(p.category, 'pokemon', 'categorised as pokemon');
  });

  test('stripped Sylveon/Greninja tin (with Spanish text) builds a product', () => {
    const p = adapter()._buildFromSearch(item(TIN_STRIPPED, { price: 39.99 }), 'pokemon 30th celebration');
    assert.ok(p, 'stripped Sylveon/Greninja tin must NOT be dropped');
    assert.strictEqual(p.category, 'pokemon');
  });

  test('full title (prefix intact) still works', () => {
    assert.ok(adapter()._buildFromSearch(item(ETB_FULL), 'pokemon'), 'full title must still pass');
  });

  test('isInScopeName accepts the stripped titles (cache/relist paths agree)', () => {
    assert.strictEqual(isInScopeName(ETB_STRIPPED), true);
    assert.strictEqual(isInScopeName(TIN_STRIPPED), true);
  });

  test('NO over-matching: a non-Pokémon item with "celebration" but not the set is still dropped', () => {
    // '30th celebration'/'30th anniversary' are specific; a generic "celebration" must not scope-in.
    assert.strictEqual(isInScopeName('Happy 30th Birthday Celebration Cake Topper'), false,
      'a party-supply "celebration" must not be treated as Pokémon');
    assert.strictEqual(adapter()._buildFromSearch(item('Yu-Gi-Oh! Booster Box Celebration Edition'), 'x'), null,
      'a non-tracked TCG must still be rejected');
  });
});
