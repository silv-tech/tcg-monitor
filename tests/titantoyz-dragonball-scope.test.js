/**
 * Dragon Ball scope for Titan Toyz ONLY, verified against the store's REAL catalogue.
 *
 * The global scope (GAME_NAMES) is deliberately shared, so Dragon Ball is added as a per-retailer
 * additive list: retailers.json `extraGameNames` -> BaseAdapter.extraGameNames -> isInScopeName's
 * optional 2nd arg. Titan Toyz opts in with ["dragon ball", "dbs "]; every other retailer passes
 * nothing and its scope is byte-for-byte unchanged.
 *
 * The titles below are verbatim from a live survey of titantoyz.com. Two real-world traps the
 * survey caught: (1) some sealed products are titled only "DBS ..." with no "dragon ball" substring;
 * (2) "dragon ball" also matches figures/plush/magazines, which must still be rejected by the
 * game-agnostic isTCGProduct gate. Both are asserted here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isInScopeName } = require('../src/utils/scope');

const TITAN = ['dragon ball', 'dbs ']; // Titan Toyz's extraGameNames

// Verbatim sealed Dragon Ball card products from titantoyz.com — every one SHOULD alert.
const SEALED = [
  'Dragon Ball Super Card Game Booster Pack REACH THE GOD FB12 Japanese version',
  'Dragon Ball Super Card Game Fusion World Booster Pack Raging Roar FB03 :Box(24packs)',
  'Dragon Ball Super Card Game Fusion World Booster Pack Awakened Pulse FB01 PACK (Japanese Version)',
  'Dragon Ball Super Card Game Fusion World Booster Pack Awakened Pulse FB01 Box (24packs)',
  'Dragon Ball Super Card Game Fusion World Booster Pack Ultra Limit FB05 (24 packs) Japanese',
  'Dragon Ball Super Card Game Fusion World Story Booster Box (Japanese)',
  'Dragon Ball Super Card Game Fusion World 2nd Complete Card Collection (Japanese)',
  'Dragon Ball Super Card Game Fusion World Start Deck Son Gokou FS01',
  'Dragon Ball Super Card Game Fusion World Start Deck Vegeta FS02',
  'Dragon Ball Super Card Game Fusion World Start Deck Broly FS03',
  'Dragon Ball Super Card Game Fusion World Start Deck Frieza FS04',
  'Dragon Ball Super Card Game Fusion World Basic Deck Earth-Grown Saiyan FS13 (Japanese)',
  'Dragon Ball Super Card Game Fusion World Basic Deck Saiyan Prince FS14 (Japanese)',
  'DRAGON BALL SUPER MASTERS TCG PREMIUM ANN BOX 2025',
  'Dragon Ball Super Battle Card Master Thirty-Third Booster Box B33 (Japanese)',
  'Dragon Ball Super Divers Advance Pack Vol.2 Box',
  'Dragon Ball Super Divers Advance Pack Vol.2',
  'Dragon Ball Super Divers Advance Pack Battle of Saiyans Box',
  'Super Dragon Ball Heroes Starter Pack -The Battle of Planet Namek Ver. (Box/12pack)',
  'DBS ZENKAI SERIES 3 BOOSTER BOX',
  'DBS ZENKAI SERIES 4 BOOSTER BOX',
  "DBS FUSION WORLD FB08 08 SAIYAN'S PRIDE BOOSTER BOX",
  'DBS MASTERS ZENKAI SERIES EX 10 BOOSTER',
  'DBS FUSION WORLD 05 BOOSTER',
  'DBS FUSION WORLD FB02 BOOSTER',
];

// Dragon Ball items that are NOT trading-card product — must NOT alert even for Titan Toyz.
const NON_CARD = [
  'Dragon Ball Super Vs. Dragon Ball SP03 Dragon Ball Battle Figure Series',
  'S.H. Figuarts Dragon Ball Super Saiyan Son Goku',
  'Dragon Ball Dragon Stars Series Wave 20 Super Saiyan Vegeta',
  'Dragon Ball World Collectable Figure Son Goku',
  'Dragon Ball Super Saiyan Plush Set',
  'Dragon Ball Monthly Magazine V Jump December 2025',
];

describe('Dragon Ball sealed product scopes IN for Titan Toyz', () => {
  for (const title of SEALED) {
    test(`IN: ${title.slice(0, 60)}`, () => {
      assert.strictEqual(isInScopeName(title, TITAN), true, `sealed DB must scope in for Titan Toyz: "${title}"`);
    });
  }
});

describe('Dragon Ball non-card items are rejected even for Titan Toyz', () => {
  for (const title of NON_CARD) {
    test(`OUT: ${title.slice(0, 60)}`, () => {
      assert.strictEqual(isInScopeName(title, TITAN), false, `non-card DB must NOT scope in: "${title}"`);
    });
  }
});

describe('Dragon Ball is Titan Toyz-ONLY — off for every other retailer', () => {
  test('with NO extraGameNames, all the sealed DB products scope OUT (default global behaviour)', () => {
    for (const title of SEALED) {
      assert.strictEqual(isInScopeName(title), false, `DB must be out of scope by default: "${title}"`);
    }
  });
  test('an empty extraGameNames array is identical to omitting it', () => {
    for (const title of SEALED) assert.strictEqual(isInScopeName(title, []), false);
  });
});

describe('no regression: Pokémon / One Piece unchanged, junk still rejected', () => {
  test('Pokémon and One Piece sealed still scope in (with and without the DB extra)', () => {
    for (const t of ['Pokémon TCG: 30th Celebration Elite Trainer Box', 'One Piece Card Game Romance Dawn Booster Box']) {
      assert.strictEqual(isInScopeName(t), true);
      assert.strictEqual(isInScopeName(t, TITAN), true, 'the DB extra must not disturb existing games');
    }
  });
  test('the DB extra does not scope-in a non-DB, non-TCG product', () => {
    assert.strictEqual(isInScopeName('UNO Card Game', TITAN), false, 'UNO names no tracked game');
    assert.strictEqual(isInScopeName('Yu-Gi-Oh! Booster Box', TITAN), false, 'other TCGs stay out — DB extra is specific');
  });
});
