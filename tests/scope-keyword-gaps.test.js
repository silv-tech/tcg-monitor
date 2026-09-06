/**
 * Gaps found by auditing the live rule against all 18 stores, after the shops were scoped.
 * Each of these was a real product being handled wrongly in production.
 *
 * The One Piece one is the important one. 'hat ' sat in the non-TCG list to catch headwear,
 * and it matches "Straw Hat Crew" — a phrase that runs through One Piece's entire range. It
 * was silently classifying One Piece starter decks and booster boxes as clothing, in a
 * monitor whose whole scope is Pokemon and One Piece. A missed drop leaves no trace, so
 * nothing would have reported it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName } = require('../src/utils/scope');
const { isTCGProduct } = require('../src/utils/helpers');

describe('keyword gaps: sealed forms that were missing', () => {
  const kept = [
    // "battle deck" had no entry at all; V and Mega Battle Decks are ordinary sealed product.
    'Pokémon GO V Battle Deck',
    'Pokémon V Battle Deck - Rayquaza V',
    'Pokemon - Mega Battle Deck - Mega Diancie ex',
    'Pokemon 30th Celebration Battle Deck Espeon ex/Umbreon ex',
    'Pokemon Sword & Shield V Battle Deck Lycanroc VS Corviknight',
    // The list had "build and battle" but the boxes are printed with an ampersand.
    'Pokemon - ME5 - Pitch Black - Build & Battle (Limit 2 Per Customer)',
    'Pokémon - Sword & Shield Fusion Strike - Build & Battle Stadium',
  ];
  for (const name of kept) {
    test('keeps ' + name.slice(0, 50), () => {
      assert.strictEqual(isTCGProduct(name), true);
      assert.strictEqual(isInScopeName(name), true);
    });
  }
});

describe('keyword gaps: "Straw Hat" is One Piece, not headwear', () => {
  const oneP = [
    'One Piece CG - ST01 - Straw Hat Crew Starter Deck',
    'One Piece Card Game - Straw Hat Crew - Booster Box',
    'One Piece Card Game ST-01 Straw Hat Crew Starter Deck Display',
  ];
  for (const name of oneP) {
    test('keeps ' + name.slice(0, 50), () => assert.strictEqual(isInScopeName(name), true));
  }

  test('real headwear is still rejected', () => {
    assert.strictEqual(isInScopeName('Pokemon Baseball Hat Pikachu'), false);
    assert.strictEqual(isInScopeName('Pokemon Bucket Hat Charizard'), false);
    assert.strictEqual(isInScopeName('Pokemon Snapback Cap'), false);
  });

  test("'cap ' was the same hazard — One Piece is full of captains", () => {
    assert.strictEqual(isInScopeName('One Piece Card Game - Captain Buggy - Booster Box'), true);
    assert.strictEqual(isInScopeName('Pokemon Baseball Cap Snorlax'), false);
  });
});

describe('keyword gaps: merch that was being kept', () => {
  test('Re-Ment makes trinkets and terrariums, not cards', () => {
    assert.strictEqual(isInScopeName('Re-Ment - Pokémon Terrarium Collection Vol.15'), false);
    assert.strictEqual(isInScopeName('Re-Ment - Pokémon Gemstone Collection Shining Miracle'), false);
    assert.strictEqual(isInScopeName('Re-Ment - Pokémon Little Night Collection 2'), false);
  });

  test('a party game that merely names the franchise is still rejected', () => {
    assert.strictEqual(isInScopeName('Asmodee Spot It! One Piece (Multilingual Edition)'), false);
  });
});

describe('keyword gaps: sealed product that only LOOKS like merch is kept', () => {
  // Each of these contains a word that reads as merchandise — figure, sticker, tournament —
  // but they are all sealed products with cards in them.
  const kept = [
    'Pokémon TCG: Mega Lucario ex Figure Collection',
    'Pokemon Trading Card Game White Flare Tech Sticker Collection',
    'Pokemon Trading Card Game: Lillie Premium Tournament Collection',
    'Pokemon TCG: Celebrations Premium Figure Collection - Pikachu VMAX',
  ];
  for (const name of kept) {
    test('keeps ' + name.slice(0, 50), () => assert.strictEqual(isInScopeName(name), true));
  }

  test('an accessory pouch is still an accessory', () => {
    assert.strictEqual(
      isInScopeName('Pokemon Tcg Scarlet And Violet Prismatic Evolutions Accessory Pouch'),
      false
    );
  });
});

/**
 * A sealed box describes its own contents, so the word "accessories" appears inside real
 * product titles. It was vetoing them TWICE — once via ACCESSORY_KEYWORDS and again via the
 * accessory entries inside isTCGProduct — so Best Buy's Stellar Crown ETB was discarded.
 *
 * An unambiguous sealed type now settles the question, but only AFTER the single-card check,
 * so a promo card named after the box it came from is still rejected.
 */
describe('scope: an unambiguous sealed type outranks the accessory words', () => {
  const kept = [
    'Pokemon USA Pokemon Trading Card Game: Scarlet & Violet (SV7) Stellar Crown Elite Trainer Box 9 packs & accessories',
    'Pokemon TCG Elite Trainer Box with sleeves and dice',
    'Pokemon TCG Booster Bundle with card sleeves',
  ];
  for (const name of kept) {
    test('keeps ' + name.slice(0, 46), () => assert.strictEqual(isInScopeName(name), true));
  }

  test('the shortcut does NOT rescue a single named after its box', () => {
    // isSingleCard runs first, which is the ordering this test exists to lock.
    assert.strictEqual(
      isInScopeName('Eevee (173) - Prismatic Evolutions Pokemon Center ETB - Promo'),
      false
    );
  });

  const dropped = [
    'Pokemon Scarlet & Violet: Prismatic Evolutions Accessory Pouch',
    'Ultra PRO Pokemon Card Sleeves 100ct',
    'Ultra Pro Pokemon Alcove Flip Deck Box',
    'Pokemon 9-Pocket Portfolio Binder',
    'Ultra PRO Pokemon Trading Card Book - 252 Cards',
  ];
  for (const name of dropped) {
    test('still drops ' + name.slice(0, 44), () => assert.strictEqual(isInScopeName(name), false));
  }
});

describe('scope: the source file carries no stray control characters', () => {
  test('no backspace or other control byte survived an escaping slip', () => {
    // A \b written as a real backspace inside DEFINITE_SEALED made it match nothing, and
    // the rule silently failed open. Cheap to assert, invisible otherwise.
    const src = require('fs').readFileSync(require.resolve('../src/utils/scope.js'), 'utf8');
    const bad = [...src].filter((c) => {
      const code = c.charCodeAt(0);
      return code < 32 && c !== '\n' && c !== '\r' && c !== '\t';
    });
    assert.strictEqual(bad.length, 0, 'found control chars: ' + JSON.stringify(bad));
  });
});
