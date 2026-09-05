/**
 * Non-TCG filter.
 *
 * 25 of 31 shops track their whole catalogue, so tcgfy was monitoring women's shoes. The
 * obvious fix — an include-list of TCG keywords — was tested against live data and dropped
 * 85 real Pokemon cards from zardocards alone, because card titles use character and set
 * names rather than the game's name. A missed drop is the failure this product exists to
 * prevent; a junk alert is merely annoying. So the filter excludes rather than includes,
 * and anything that smells like a card is rescued even when its category looks wrong.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isNonTcg } = require('../src/adapters/shopify');

const item = (title, product_type = '', tags = []) => ({ title, product_type, tags });

describe('non-TCG filter: removes what is provably not a card', () => {
  const junk = [
    ['Women’s Feather Fur Peep Toe Mules – Thin High Heel', 'shoes'],
    ['L\'Oreal Professionnel Serioxyl Advanced Shampoo 500 mL', 'Shampoo'],
    ['Gundam Rogue Orbit - Launch Edition [Xbox Series X]', 'Xbox Series X Video Games'],
    ['Funko POP! KPOP Demon Hunters Zoey', 'Funko pop'],
    ['Warhammer 40,000 - Orks - Warboss (50-84)', 'Warhammer'],
    ['Monopoly - Harry Potter Edition', 'Board Games'],
    ['Japanese Kawaii Backpack for Women & Girls', 'bags'],
  ];
  for (const [title, type] of junk) {
    test(`removes: ${title.slice(0, 44)}`, () => {
      assert.strictEqual(isNonTcg(item(title, type)), true);
    });
  }
});

describe('non-TCG filter: never removes a card', () => {
  // Every one of these was WRONGLY dropped by the include-list approach, on live data.
  const cards = [
    ['PSA 10 PICHU - SPIKY EARED', ''],
    ['Rayquaza Vmax 102/159 Crown Zenith', ''],
    ['Eevee ex (174) - SV Scarlet & Violet Promo Cards Holofoil', ''],
    ['Lillie\'s Clefairy ex (184/159) - SV09 Journey Together Holofoil', ''],
    ['Vaporeon Holo 18/68 Hidden Fates', ''],
    ['Wicke (Full Art) (147/147) - SM Burning Shadows Holofoil', ''],
    ['Mega Floette ex (117/086) - ME04 Chaos Rising Holofoil', 'Single Card'],
    ['Yasopp (OP17-031) - The World\'s Strongest', 'one piece single'],
    ['Dispatch (0002) (SLZ-002) - Secret Lair', 'mtg single'],
    ['Focused Flames (Interference Curio Foil)', 'grand archive tcg singles'],
    ['Radiant Typhoon Mandate [MAMO-EN118] Ultra Rare', 'yugioh single'],
  ];
  for (const [title, type] of cards) {
    test(`keeps: ${title.slice(0, 44)}`, () => {
      assert.strictEqual(isNonTcg(item(title, type)), false);
    });
  }

  test('rescue beats a wrong-looking category', () => {
    // A sealed Pokemon box filed under "Toys & Games" must survive — that category is used
    // for real sealed product (Grand Archive boxes were found under it on live data).
    assert.strictEqual(isNonTcg(item('Pokemon Booster Bundle', 'Toys & Games')), false);
  });

  test('merch is still removed even when it is Pokemon merch', () => {
    // A plush toy is not a card. It carries no rescue term (character names deliberately are
    // NOT rescue terms — that is the include-list trap), so its category decides.
    assert.strictEqual(isNonTcg(item('Snorlax Plush Cushion', 'plush toys')), true);
  });

  test('but merch NAMED like sealed product is kept, because the cost is asymmetric', () => {
    // "booster" rescues this even though it is filed as a plush. One junk alert beats
    // silently dropping a real booster box that a shop miscategorised.
    assert.strictEqual(isNonTcg(item('Booster Box Plush Replica', 'plush toys')), false);
  });

  test('an untyped, unremarkable product is kept rather than guessed at', () => {
    assert.strictEqual(isNonTcg(item('Reality Fracture 2HG Pre-Release - Sunday', '')), false);
  });
});
