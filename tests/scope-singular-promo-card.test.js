/**
 * A SEALED box that lists a promo card among its CONTENTS is not a single card.
 *
 * THE BUG, measured live 2026-09-12. `src/adapters/amazon.js` logs
 * `dropping out-of-scope cached ASIN` for six ASINs every 30-90s, continuously for hours. Three of
 * them are genuine sealed product and are being deleted from the catalogue on every poll:
 *
 *   B0GSC9654K  Mega Evolution: Ascended Heroes: 2-pack blister (... promotional card and coins)
 *   B0GSCJ3V5C  Ascended Heroes: Pack of 2 Blister Packs (2 Booster Packs, Promotion Card and Coin)
 *   B0GTRFRHW3  Mega Zygarde-ex Premium Collection (one promotional card, ... eight expansion packs)
 *
 * They are absent from Redis entirely. `_buildFromSearch` re-admits them every poll using the
 * looser `hasGameScope` + `isTCGProduct`, then the scope purge deletes them again — so they can
 * never reach the diff and can never alert. A permanent, looping loss of three real products.
 *
 * THE CAUSE is one character. `SINGLE_CARD_MARKERS` carries `/\bpromotion(?:al)? cards?\b/i`, and
 * the comment directly above it states the intent in as many words:
 *
 *     "One Piece Promotion Cards"  — plural CARDS, i.e. the cards, not the box
 *
 * The `s?` makes the plural optional, so the marker also fires on the SINGULAR — which is exactly
 * how a sealed box describes what is inside it ("...and one promotional card"). The regex
 * contradicts its own documented contract.
 *
 * Ordering makes it unrecoverable: `isSingleCard` runs at scope.js:313, BEFORE the
 * `DEFINITE_SEALED` shortcut at :329 — so even though two of the three match a definite sealed
 * form ("Booster Packs", "Premium Collection"), that evidence never gets to speak.
 *
 * This is NOT a new heuristic. The standing rule is not to invent title regexes for scope false
 * negatives; this restores a marker to the behaviour its own comment specifies, and the tests below
 * pin BOTH directions so the singles it was written to catch stay caught.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isInScopeName } = require('../src/utils/scope');

// Verbatim from `railway logs --filter "dropping out-of-scope cached ASIN"`, 2026-09-12.
const SEALED_WRONGLY_DROPPED = [
  ['B0GSC9654K', 'Pokemon TCG: Mega Evolution: Ascended Heroes: 2-pack blister (2 supplementary packages, promotional card and coins) (Erika\'s Tangela)'],
  ['B0GSCJ3V5C', 'Pokemon TCG: Mega Evolution: Ascended Heroes: Pack of 2 Blister Packs (2 Booster Packs, Promotion Card and Coin) (Larry\'s Komala)'],
  ['B0GTRFRHW3', 'Mega Zygarde-ex Premium Collection by GCC Pokémon (one promotional card, one giant lenticular card, one sticker and eight expansion packs)'],
];

// Also dropped in the same window, and CORRECTLY so. These must stay out.
const CORRECTLY_DROPPED = [
  ['B0BST4BC6S', 'Pokemon - Donphan 107/123 - Celebrations Classic Collection'],
  ['B0BST4T7NN', "Pokemon - Rocket's Zapdos - 15/132 - Celebrations Classic Collection"],
  ['B0FDKQ6F5G', 'Paladone One Piece Jolly Rogers Playing Cards for Poker, Rummy, Go Fish, Card Games, Officially Licensed Anime Merchandise & Collectible Gift in Metal Tin'],
];

describe('a sealed box listing a promo card in its contents stays in scope', () => {
  for (const [asin, name] of SEALED_WRONGLY_DROPPED) {
    test(`${asin} is genuine sealed product and must be tracked`, () => {
      assert.strictEqual(isInScopeName(name), true,
        `deleted from the catalogue every poll since at least 2026-09-12 — ${name.slice(0, 80)}`);
    });
  }
});

describe('the singles the marker exists to catch are still caught', () => {
  for (const [asin, name] of CORRECTLY_DROPPED) {
    test(`${asin} must stay out of scope`, () => {
      assert.strictEqual(isInScopeName(name), false, name.slice(0, 80));
    });
  }

  test('the PLURAL phrase the comment names still rejects', () => {
    // The literal example from the comment at scope.js:277.
    assert.strictEqual(isInScopeName('One Piece Promotion Cards'), false);
    assert.strictEqual(isInScopeName('Pokemon Promotional Cards Lot'), false);
  });

  test('a single named after its box is still rejected', () => {
    // The case the ordering comment at scope.js:311-312 exists for.
    assert.strictEqual(
      isInScopeName('Eevee (173) - Prismatic Evolutions Pokemon Center ETB - Promo'), false);
  });

  test('the other single-card markers are untouched', () => {
    assert.strictEqual(isInScopeName('One Piece Luffy (P-019) Promo'), false);
    assert.strictEqual(isInScopeName('Charizard NM-Mint Base Set'), false);
    assert.strictEqual(isInScopeName('Pikachu Slightly Played Jungle'), false);
  });
});

describe('ordinary sealed product is unaffected', () => {
  const SEALED = [
    'Pokemon TCG: Scarlet & Violet—Prismatic Evolutions Elite Trainer Box',
    'Pokémon TCG: 30th Celebration Ultra-Premium Collection',
    'One Piece Card Game OP-11 Booster Box',
  ];
  for (const name of SEALED) {
    test(`still in scope: ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isInScopeName(name), true);
    });
  }
});
