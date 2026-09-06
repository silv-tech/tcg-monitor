/**
 * Sealed "collection" forms that are product, not accessory.
 *
 * Pokemon Center was the last store deciding its own scope. When it adopted the shared rule,
 * 413 accessories correctly disappeared — but so did 28 genuine sealed products: pin
 * collections, poster collections, tech sticker collections and the holiday calendar. Each is
 * a factory-sealed box with booster packs and a promo card inside, and 'poster-collection' was
 * already in the adapter's own keyword list, so dropping them was never intended.
 *
 * That class of bug is worse than a false alert: a product that silently stops being watched
 * produces no wrong field to notice, just an alert that never arrives.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName } = require('../src/utils/scope');

describe('sealed collection forms are in scope', () => {
  const SEALED = [
    'Pokemon Tcg Shining Legends Pin Collection Zoroark',
    'Pokemon Tcg Crown Zenith Pin Collection Rillaboom',
    'Pokemon Tcg Celebrations Deluxe Pin Collection',
    'Pokemon Tcg Unova Poster Collection',
    'Pokemon Tcg Scarlet And Violet 151 Poster Collection',
    'Pokemon Tcg Scarlet And Violet Black Bolt Tech Sticker Collection',
    'Pokemon Tcg Glaceon Vstar Special Collection',
    'Pokemon Tcg Holiday Calendar Glaceon Crabominable Articuno Deluxe',
  ];
  for (const name of SEALED) {
    test(`keeps: ${name.slice(0, 52)}`, () => {
      assert.strictEqual(isInScopeName(name), true);
    });
  }
});

describe('accessories stay out, including ones that look collection-ish', () => {
  const ACCESSORIES = [
    'Pokemon Tcg Mewtwo And Mew Dna Premium Zip Binder',
    'Pokemon Tcg Wooloo Fluffy Flock Card Sleeves 65 Sleeves',
    'Pokemon Tcg Explore Pokemon Premium Playmat',
    'Pokemon Tcg Deck Buddies Gengar Deck Box',
    'Pokemon Tcg Celestial Espeon And Umbreon Backpack',
    'Pokemon Tcg Celestial Espeon And Umbreon Bag Tag',
    'Pokemon Tcg Scarlet And Violet Paldea Evolved Collector S Album',
    'Pokemon Tcg Eevee Coin Display Plush Key Chain',
    'Pokemon Tcg Celestial Umbreon Card Protector Display',
    'Gardevoir And Gallade Tcg Accessories And Gardevoir Plush Bundle',
  ];
  for (const name of ACCESSORIES) {
    test(`drops: ${name.slice(0, 52)}`, () => {
      assert.strictEqual(isInScopeName(name), false);
    });
  }
});

describe('the rescue does not open a hole in other stores', () => {
  test('a sleeve is still out even when a set name is present', () => {
    assert.strictEqual(isInScopeName('Pokemon TCG Surging Sparks Card Sleeves 65ct'), false);
  });
  test('an unrelated product naming a game is still out', () => {
    assert.strictEqual(isInScopeName('Pokemon Pikachu Plush Keychain'), false);
  });
  test('"collection" alone does not admit an accessory', () => {
    assert.strictEqual(isInScopeName('Pokemon TCG Charizard Binder Collection'), false);
  });
});

describe('boxed play accessories are not sealed product', () => {
  // The Pokemon Center category sweep reported exactly four in-scope products in stock, and
  // every one was a dice/marker set — they read as "<game> ... Set" and slipped through on
  // game name plus form.
  const DICE = [
    'Pokemon Tcg Substitute Damage Counter Dice And Condition Markers',
    'Pokemon Tcg Koffing And Weezing Sunset Damage Counter Dice And Condition Markers',
    'Pokemon Tcg Digletts Cave Damage Counter Dice And Condition Markers',
    'Pokemon Tcg Celadon Game Corner Damage Counter Dice And Condition Markers',
  ];
  for (const name of DICE) {
    test(`drops: ${name.slice(0, 50)}`, () => {
      assert.strictEqual(isInScopeName(name), false);
    });
  }

  test('a real sealed box is still kept', () => {
    assert.strictEqual(isInScopeName('Pokemon Tcg Scarlet And Violet Surging Sparks Booster Bundle'), true);
  });
});
