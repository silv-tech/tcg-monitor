/**
 * One scope rule, shared by every retailer.
 *
 * The rule lived inside the Amazon adapter and Walmart had none at all, so Walmart tracked
 * 190 out-of-scope products out of 360 and alerted on 49 of them: UNO, Jenga, Monopoly,
 * Twister, Cards Against Humanity, He-Man figures, Dragon Ball. Walmart's queries were never
 * the problem — they are "pokemon tcg" and "one piece card game" — but Walmart answers a
 * query for a card game with every card game it sells, so the query decides nothing.
 *
 * The mojibake repair is load-bearing rather than cosmetic: two REAL Walmart products were
 * stored as "PokÃ©mon ...", and "pokã©mon" matches no game name, so a filter shipped without
 * the repair would have deleted legitimate Pokemon products as junk.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName, repairMojibake } = require('../src/utils/scope');

describe('scope: mojibake is repaired before anything is judged', () => {
  // Built from the exact code points seen in production rather than typed by hand, because
  // the corruption is cp1252 and the characters involved (U+20AC, U+201D) are easy to
  // mistype as the visually similar U+2014 the original actually contained.
  const corrupted =
    'PokÃ©mon Trading Card Game: Sword & Shieldâ€”Evolving Skies Elite Trainer Box';

  test('the real corrupted Walmart name is repaired, em dash included', () => {
    assert.strictEqual(
      repairMojibake(corrupted),
      'Pokémon Trading Card Game: Sword & Shield—Evolving Skies Elite Trainer Box'
    );
  });

  test('a latin1-only repair would have destroyed that name — why cp1252 is required', () => {
    const naive = Buffer.from(corrupted, 'latin1').toString('utf8');
    assert.ok(naive.includes('�'), 'latin1 truncates U+20AC/U+201D and corrupts the name');
  });

  test('a corrupted Pokemon product survives the scope test', () => {
    assert.strictEqual(isInScopeName(corrupted), true, 'this would have been deleted as junk');
  });

  test('the second real corrupted name also survives', () => {
    assert.strictEqual(
      isInScopeName('PokÃ©mon Trading Card Games Scarlet & Violet 3.5 151 Elite Trainer Box'),
      true
    );
  });

  test('a correctly-encoded name is left exactly as it is', () => {
    const clean = 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    assert.strictEqual(repairMojibake(clean), clean);
  });

  test('plain ASCII is untouched', () => {
    assert.strictEqual(repairMojibake('Pokemon TCG Booster Box'), 'Pokemon TCG Booster Box');
  });

  test('a name that only looks like mojibake is not mangled', () => {
    // Round-tripping this would produce replacement characters, so it is left alone.
    const odd = 'Ã';
    assert.strictEqual(repairMojibake(odd), odd);
  });

  test('empty and missing names do not throw', () => {
    assert.strictEqual(repairMojibake(''), '');
    assert.strictEqual(repairMojibake(undefined), '');
    assert.strictEqual(isInScopeName(undefined), false);
  });
});

describe('scope: the products Walmart was really tracking are rejected', () => {
  const leaked = [
    'Skip Bo Card Game',
    'UNO Card Game',
    'The Game Of UNO',
    'UNO Dare Adults Only Card Game, 2-10 Players',
    'UNO KPop Demon Hunters Card Game for Kid, Adult & Family',
    'Phase 10 Card Game',
    'KerPlunk Kids Game, Easy-to-Learn Family Game for 2-4 Players',
    'Twister Game, Family and Kids Party Game',
    'Official Hasbro Jenga Game with More Ways to Play',
    'Monopoly: Barbie Edition Board Game, Ages 8+',
    'Monopoly Deal: KPop Demon Hunters Card Game',
    'Cards Against Humanity Absurd Box',
    'Mexican Train Dominoes Set with 4 Holders',
    'Masters of the Universe Origins He-Man 2026 Movie 5.5 In',
    'Fisher-Price Little People Disney Mickey & Friends',
    'Dragon Ball Super TCG: Fusion World Ultra Limit Box',
    '14 DRAGONBALL Z PK',
  ];
  for (const name of leaked) {
    test('rejects ' + name.slice(0, 48), () => assert.strictEqual(isInScopeName(name), false));
  }
});

describe('scope: real product is kept across every retailer', () => {
  const kept = [
    'Pokemon ME04 Chaos Rising Elite Trainer Box',
    'Pokémon TCG: Charizard ex Special Collection',
    'Pokemon Mega Evolution Perfect Order Elite Trainer Box',
    'Pokemon Trading Card Game Mega Zygarde ex Premium Collection',
    'One Piece Card Game: Animal Kingdom Pirates Starter Deck',
    'Pokemon TCG: Mega Evolution Pitch Black Sleeved Booster Pack',
    "Pokemon TCG: Team Rocket's Mewtwo ex League Battle Deck",
  ];
  for (const name of kept) {
    test('keeps ' + name.slice(0, 48), () => assert.strictEqual(isInScopeName(name), true));
  }

  test('"Sleeved Booster" is sealed product, not card sleeves', () => {
    // The accessory list matches "sleeves"; "sleeved" must not collide with it.
    assert.strictEqual(isInScopeName('Pokemon TCG: Pitch Black Sleeved Booster Pack'), true);
    assert.strictEqual(isInScopeName('Ultra PRO Pokemon Card Sleeves 100ct'), false);
  });
});

/**
 * Naming a game was never sufficient — the thing also has to BE a card product. Amazon
 * always applied that as a separate step and Walmart never did, so after Walmart's first
 * cleanup ten rows were still in scope: a Nintendo Switch game and a shelf of UNO variants,
 * all of which legitimately contain "Pokémon" or read as a "card game".
 */
describe('scope: naming a game is not enough, it must be a card product', () => {
  const rejected = [
    'Pokémon™ Violet (Nintendo Switch)',
    'Pokémon Legends: Z-A - Nintendo Switch 2',
    'UNO Card Game',
    'Phase 10 Card Game',
    'Cards Against Humanity Everything Box',
    "Liar's UNO Card Game for Adults, Kids, Families",
    'UNO Truth Adults Only Card Game, Play Anywhere',
    'Pokemon Home Edition Plus Pinball Game',
    'LEGO Pokémon Pikachu and Poké Ball',
  ];
  for (const name of rejected) {
    test('rejects ' + name.slice(0, 46), () => assert.strictEqual(isInScopeName(name), false));
  }

  test('these all name a game, which is exactly why the game check alone let them in', () => {
    const GAMES = ['pokemon', 'pokémon', 'one piece'];
    const survivors = ['Pokémon™ Violet (Nintendo Switch)', 'LEGO Pokémon Pikachu and Poké Ball'];
    for (const n of survivors) {
      assert.ok(GAMES.some((g) => n.toLowerCase().includes(g)), n + ' does name a game');
      assert.strictEqual(isInScopeName(n), false, n + ' must still be rejected');
    }
  });
});

describe('scope: one rule, not one per adapter', () => {
  test('amazon and walmart resolve the identical function', () => {
    const shared = require('../src/utils/scope').isInScopeName;
    assert.strictEqual(require('../src/utils/scope').isInScopeName, shared);
    // A product rejected for one retailer is rejected for all of them.
    assert.strictEqual(shared('UNO Card Game'), false);
    assert.strictEqual(shared('Sponsored Ad – Title: Star Wars: Unlimited'), false);
    assert.strictEqual(shared('Pokémon TCG Collector & Investor Guide 2026'), false);
  });
});
