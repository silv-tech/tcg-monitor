/**
 * SET_NAMES is what rescues a product whose title drops the franchise word — and it had a hole.
 *
 * Retailers routinely omit "Pokemon". Walmart lists this monitor's own watchlist item as
 * "Scarlet & Violet—Prismatic Evolutions Elite Trainer Box", with the franchise nowhere in it. So
 * `isInScopeName` accepts a recognised SET name as proof of the game. That list is hand-maintained,
 * and it ran from Vivid Voltage to Crown Zenith and then from Scarlet & Violet forward — skipping
 * six real Sword & Shield sets in the middle. A booster box titled by one of those sets alone was
 * silently dropped.
 *
 * Measured across all 19 retailers (86,709 stored rows) on 2026-09-11: adding them recovers 39 rows,
 * 29 of them in stock, with nothing junk admitted and nothing knocked out of scope. Among them a
 * $859 Rebel Clash booster box, a $4,389 Darkness Ablaze sealed case, a $4,055 "151 Blooming Waters"
 * case, and One Piece OP-17 — a set that only just started shipping, so this is live stock and not
 * historical backlog.
 *
 * THE 151 ENTRIES ARE ANCHORED ON PURPOSE. A bare '151' would match a "151-piece jigsaw puzzle" and
 * a "151-count storage box". Anchoring each entry to a sealed form keeps the recovery without
 * opening that door, and the adversarial cases below exist to keep it shut.
 *
 * Deliberately NOT attempted here: a further 61 stored rows still fail for want of a game name, but
 * they are vintage/pre-SWSH/foreign sets at a single specialty reseller, or products naming no set
 * at all ("Walking Wake Ex Tins", "Arceus VSTAR Ultra-Premium Collection"). No SET_NAMES addition,
 * however exhaustive, reaches those — they need a different mechanism, and chasing them here would
 * mean guessing at a load-bearing rule for no measured gain.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isInScopeName, collapseSpaces } = require('../src/utils/scope');

describe('the six skipped Sword & Shield sets are recognised', () => {
  const RECOVERED = [
    'Rebel Clash Booster Box',
    'Darkness Ablaze Booster Box (Sealed Case)',
    "Champion's Path Elite Trainer Box",
    'Champions Path Elite Trainer Box',
    'Shining Fates Elite Trainer Box',
    'Battle Styles Booster Box',
    'Chilling Reign Booster Box',
  ];
  for (const name of RECOVERED) {
    test(`"${name}" is in scope without naming the franchise`, () => {
      assert.strictEqual(isInScopeName(name), true);
    });
  }
});

describe('151 is anchored to sealed forms, never bare', () => {
  for (const name of ['151 Booster Bundle', '151 Elite Trainer Box', '151 Blooming Waters Collection Box',
    '151 Ultra Premium Collection', '151 Poster Collection', '151 Pin Collection']) {
    test(`"${name}" is in scope`, () => assert.strictEqual(isInScopeName(name), true));
  }

  // The whole reason the entries are phrases and not a bare number.
  for (const name of ['151 Piece Jigsaw Puzzle', '151-count Storage Box for Trading Cards',
    'Ravensburger 151 Piece Puzzle', 'Screwdriver Set 151 Pieces']) {
    test(`"${name}" stays OUT`, () => assert.strictEqual(isInScopeName(name), false,
      'a bare 151 entry would have admitted this'));
  }
});

describe('One Piece OP-17 and the 2025 tin line', () => {
  test("OP-17 by its set name alone is in scope", () => {
    assert.strictEqual(isInScopeName("The World's Strongest Warriors Booster Box"), true);
  });
  test('the apostrophe-free spelling also works', () => {
    assert.strictEqual(isInScopeName('The Worlds Strongest Warriors Booster Pack'), true);
  });
  test('Slashing Legends tins are in scope', () => {
    assert.strictEqual(isInScopeName('Slashing Legends Tin'), true);
  });
});

describe('the added names do not admit other franchises', () => {
  for (const name of [
    'Star Wars Unlimited: Rebel Clash Booster Box',
    "Dog Training: A Champion's Path Hardcover Book",
    "World's Strongest Warriors Boxing Documentary DVD",
    'Battle Styles Karate Training Mat',
  ]) {
    test(`"${name}" stays OUT`, () => {
      assert.strictEqual(isInScopeName(name), false,
        'a set name must not carry a product from a different franchise into scope');
    });
  }

  test('accessories named after a recovered set are still rejected', () => {
    for (const n of ['Pokemon 151 Card Sleeves 65ct', 'Pokemon 151 Playmat', 'Pokemon 151 Deck Box']) {
      assert.strictEqual(isInScopeName(n), false, n);
    }
  });

  test('a graded single from a recovered set is still rejected', () => {
    assert.strictEqual(isInScopeName('PSA 10 Chilling Reign Blaziken 021/198'), false);
  });
});

describe('a doubled space no longer defeats a literal match', () => {
  test('the real doescards row is recovered', () => {
    // A $449.99 bundle titled with two spaces. Every scope check is an .includes() against a
    // single-spaced phrase, so the product named its own franchise and was rejected anyway.
    assert.strictEqual(isInScopeName('One  Piece Card Game Booster Box OP-09'), true);
  });

  test('tabs and newlines normalise too', () => {
    assert.strictEqual(isInScopeName('Pokemon\tTCG\nBooster  Box'), true);
  });

  test('collapseSpaces is exported and total', () => {
    assert.strictEqual(collapseSpaces('  a   b  '), 'a b');
    assert.strictEqual(collapseSpaces(null), '');
    assert.strictEqual(collapseSpaces(undefined), '');
  });

  test('normalising does not admit anything new on its own', () => {
    assert.strictEqual(isInScopeName('Magic  The  Gathering  Booster  Box'), false);
  });
});

describe('nothing previously in scope falls out', () => {
  for (const name of [
    'Pokemon TCG Scarlet & Violet Prismatic Evolutions Elite Trainer Box',
    'Pokemon TCG: Sword & Shield Evolving Skies Booster Box',
    'One Piece Card Game OP-09 Emperors in the New World Booster Box',
    'Pokémon Trading Card Game: 30th Celebration Elite Trainer Box',
    'Pokemon TCG: Journey Together Poster Collection',
  ]) {
    test(`"${name.slice(0, 46)}…" still in scope`, () => assert.strictEqual(isInScopeName(name), true));
  }
});

describe('a foreign franchise cannot ride in on one of our set names', () => {
  // Three real rows were being admitted this way, all in stock: a Weiss Schwarz and a
  // Cardfight!! Vanguard "Persona 30th Anniversary Booster Box" matched "30th anniversary",
  // an entry added for Pokemon's own 30th line. Measured across 86,709 stored rows, the veto
  // that stops them rejects ZERO legitimate products.
  for (const name of [
    'Weiss Schwarz - Persona 30th Anniversary Booster Box (Pre-Order)',
    'Cardfight!! Vanguard - VGE-DZ-TBP02- Persona 30th Anniversary Booster Box',
    'Yu-Gi-Oh 25th Anniversary Rebel Clash Booster Box',
    'Magic: The Gathering Celebrations Collector Booster Box',
    'Star Wars Unlimited: Rebel Clash Booster Box',
    'Disney Lorcana First Partner Chapter 5 Booster Box',
  ]) {
    test(`"${name.slice(0, 50)}…" stays OUT`, () => {
      assert.strictEqual(isInScopeName(name), false);
    });
  }

  test("a retailer's GRANTED franchise is never vetoed", () => {
    // Titan Toyz is granted Dragon Ball. Vetoing a franchise a store is explicitly allowed would
    // silently drop 56 real rows, which is the failure this asymmetry exists to prevent.
    const granted = ['dragon ball', 'dbs '];
    assert.strictEqual(isInScopeName('Dragon Ball Super Card Game Fusion World Booster Box', granted), true);
    assert.strictEqual(isInScopeName('Dragon Ball Super Card Game Fusion World Booster Box'), false,
      'and other retailers still reject it');
  });

  test('the veto is phrase-based, so ordinary English is safe', () => {
    // A bare 'magic' or 'vanguard' would have rejected these.
    assert.strictEqual(isInScopeName('Pokemon TCG Magical Adventure Booster Bundle'), true);
    assert.strictEqual(isInScopeName('Pokemon TCG Vanguard Vanguards Elite Trainer Box'), true);
  });
});
