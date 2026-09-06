/**
 * The card shops stock overwhelmingly SINGLE cards. The big seven sell only sealed product,
 * so this distinction never had to exist — and when the shared rule was extended to the
 * shops, 80,861 stored products reduced to 3,276, of which 52.8% were still singles.
 *
 * Measured before the rule was written: 97% of #infinitycards alerts, 94% of #pokejeux and
 * 67% of #401games were out of scope. Final sealed-only catalogue: 1,641 across 11 shops.
 *
 * The two failure modes this pins, both found against real production data:
 *   - a single named after the sealed box it came from must NOT be rescued
 *   - a sealed booster whose SET code looks like a card code must NOT be dropped
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isSingleCard, isInScopeName } = require('../src/utils/scope');

describe('singles: real single cards from the shops are rejected', () => {
  const singles = [
    'EEVEE ex (174) - POKEMON SVP EN-SV BLACK STAR PROMO - PRE SUPER',
    'Hoothoot (TG12) - Astral Radiance - Trainer Gallery Holo - Grade',
    'Zacian V (SWSH292) - Crown Zenith Premium Figure Collection',
    'Regirock (053/111) - Reverse Holofoil - Rare - MP',
    'Toxtricity (Japanese) - 044/172 - No Rarity - MP',
    "Pokemon - Rocket's Zapdos - 15/132 - Celebrations Classic Collection",
    'PSA 10 Zacian #15 MEP Black Star Promo',
    'PSA 3 (MK) Shining Gyarados #65/64 Neo Revelation Unlimited',
    'Portgas.D.Ace (Parallel) (ST22-010) [Starter Deck 22: Ace & Newgate]',
    'Misty’s Vitality (111/084) [Mega Evolution: Pitch Black] - Slightly Played',
    'Froakie (XY03) - First Partner Pack - Damaged',
  ];
  for (const name of singles) {
    test('rejects ' + name.slice(0, 48), () => {
      assert.strictEqual(isSingleCard(name), true);
      assert.strictEqual(isInScopeName(name), false);
    });
  }

  test('a single named after its sealed box is still a single', () => {
    // The exact case that a broad sealed-wording rescue got wrong: "ETB" appears in the
    // title, but the product is the promo CARD from that ETB.
    const n = 'Eevee (173) - Prismatic Evolutions Pokemon Center ETB - Promo';
    assert.strictEqual(isSingleCard(n), true);
    assert.strictEqual(isInScopeName(n), false);
  });
});

describe('singles: sealed product is never mistaken for a single', () => {
  const sealed = [
    // Set code in parens, sealed form named straight after it. These were wrongly dropped
    // by the first version of the rule — all six were real EB Games boosters.
    'Japanese Pokemon Triple Beat EX (SV1a) - Booster',
    'Japanese Pokemon Paradise Dragona EX (SV7a) - Booster',
    'Japanese Pokemon Scarlet EX (SV1s) - Booster',
    'Japanese Pokemon Violet EX (SV1v) - Booster',
    // Ordinary sealed titles
    'Pokemon - Blue Sky Stream - Japanese Booster Box',
    'One Piece Card Game - Starter Deck - ST41 (Pre-Order)',
    'One Piece Card Game - Premium Card Collection - Japanese',
    'Pokemon - Mega Evolution - Pitch Black - Elite Trainer Box',
    'Scarlet & Violet—Prismatic Evolutions Elite Trainer Box',
    'One Piece Card game - Carrying On His Will Sleeved Booster Pack',
    'Pokemon TCG: Mega Evolution Ascended Heroes Elite Trainer Box',
  ];
  for (const name of sealed) {
    test('keeps ' + name.slice(0, 48), () => {
      assert.strictEqual(isSingleCard(name), false);
      assert.strictEqual(isInScopeName(name), true);
    });
  }

  test('the rescue is anchored to the text right after the code, not the whole title', () => {
    // Sealed form immediately after the code -> sealed.
    assert.strictEqual(isSingleCard('Pokemon Triple Beat (SV1a) - Booster Box'), false);
    // Same code, but a set name follows instead of a form -> single.
    assert.strictEqual(isSingleCard('Pikachu (SV1a) - Scarlet & Violet Promo'), true);
  });
});

describe('singles: the big seven are unaffected', () => {
  test('London Drugs, Best Buy, Costco and Pokemon Center titles all survive', () => {
    const bigSeven = [
      'Pokemon TCG: Mega Evolution Pitch Black Booster Bundle',
      'Pokemon TCG: Team Rocket’s Mewtwo ex League Battle Deck',
      'Pokemon TCG: Paradox Clash Tin',
      'Pokemon Trading Card Game: Lumiose City Mini Tin',
      'Pokemon TCG: Mega Evolution Chaos Rising Checklane Blister Pack',
    ];
    for (const n of bigSeven) assert.strictEqual(isInScopeName(n), true, n);
  });
});

describe('One Piece promo singles are not sealed product', () => {
  // These were being alerted as sealed product. The trap is that the pack names are shared:
  // "Winner Pack", "Event Pack" and "Premium Card Collection" each name BOTH a sealed item and
  // the singles pulled from it, so excluding on the pack name would destroy real product.
  const SINGLES = [
    'Gorgon Sisters (Winner Pack 2026 Vol. 3) [One Piece Promotion Cards] - NM-Mint Foil',
    'Monkey.D.Luffy (Event Pack Vol. 9) [One Piece Promotion Cards] - Slightly Played Foil',
    'Bepo (Winner Pack Vol. 7) (P-019) - One Piece Promotion Cards Foil',
    'Tony Tony.Chopper (Winner Pack 2026 Vol. 2) (P-101) - One Piece Promotion Cards',
    'Sabo (Premium Card Collection -Best Selection Vol. 3-) (P-073) - One Piece Promotion Cards',
    'Jozu (Regional Participation Pack 2026 Vol.2) [One Piece Promotion Cards] - NM-Mint Foil',
    'Nico Robin [Extra Booster: One Piece Heroines Edition Vol. 2] - Slightly Played Non English',
    'Yamato (CS 2024 Event Pack) (P-046) - One Piece Promotion Cards Foil',
  ];
  for (const name of SINGLES) {
    test(`drops single: ${name.slice(0, 48)}`, () => {
      assert.strictEqual(isInScopeName(name), false);
    });
  }
});

describe('the sealed products sharing those pack names are KEPT', () => {
  // Each of these is a real sealed item a customer wants alerted, and each collides with one
  // of the single-card patterns above. This is the regression that matters: a missed alert is
  // silent, so these assertions are the guard against over-matching.
  const SEALED = [
    'One Piece Winner Pack Vol. 7 (Law Cover)',
    'One Piece Winner Pack 2025 Vol. 4 (Tsuru Cover)',
    'One Piece Day 2026 [P-161] One Piece Card Game Premium Card Collection',
    'One Piece Card Game - Premium Card Collection - Best Selection Vol 7 (Pre Order)',
    'One Piece CG Premium Card Collection Best Selection ACE & SABO & LUFFY',
    'One Piece OP-09 Emperors in the New World Booster Pack',
    'One Piece Card Game OP-17 - The Worlds Strongest Warrior Booster Box',
    'Pokemon - Scarlet and Violet - Destined Rivals Elite Trainer Box',
    'Pokemon Ascended Heroes Booster Pack',
  ];
  for (const name of SEALED) {
    test(`keeps sealed: ${name.slice(0, 48)}`, () => {
      assert.strictEqual(isInScopeName(name), true);
    });
  }
});
