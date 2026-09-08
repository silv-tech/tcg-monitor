/**
 * "Also In Stock" must name the SAME product, not merely the same kind of thing.
 *
 * Reported 2026-09-08: an EB Games restock alert for "Pokemon Trading Card Game Bloodmoon
 * Ursaluna EX Box" ($34.99) carried "Also In Stock: amazon — $700.00", and the link went to a
 * Pokemon TCG Celebrations Elite Trainer Box. Two entirely different products.
 *
 * The $700 was real, which is exactly what made it convincing — the price was not fabricated,
 * the MATCH was wrong. Jaccard scored it 0.417, over the 0.4 threshold, on these shared
 * tokens: pokemon, trading, card, game, box. Not one of them identifies a product. Prismatic
 * Evolutions ETB scores the identical 0.417 against the same source, so this was systemic
 * rather than one unlucky pair: any two Pokemon sealed products sharing the boilerplate
 * prefix plus "box" matched each other.
 *
 * A wrong field is worse than a missing one, and this one appears on every alert for the
 * product, so these pin the rule rather than the threshold.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');

const src = (name) => ({ name, retailerId: 'ebgames', sku: '804297' });

/** Put one competing product in the index and ask whether it matches. */
async function matches(sourceName, otherName) {
  state.setRetailerIndex('amazon', {
    X: { sku: 'X1', name: otherName, price: 700, url: 'https://amazon.ca/dp/X1', inStock: true },
  });
  const found = await state.findCrossRetailerMatches(src(sourceName));
  return found.length > 0;
}

beforeEach(() => {
  // Clear both retailers out of the shared in-memory index between cases.
  state.setRetailerIndex('amazon', {});
  state.setRetailerIndex('ebgames', {});
});

const URSALUNA = 'Pokemon Trading Card Game Bloodmoon Ursaluna EX Box';

describe('cross-retailer: products that only LOOK alike are not matched', () => {
  test('the reported alert — a Celebrations ETB is not a Bloodmoon Ursaluna box', async () => {
    assert.strictEqual(
      await matches(URSALUNA, 'Pokemon Trading Card Game: Celebrations Elite Trainer Box, Multicoloured'),
      false,
    );
  });

  test('a different set in the same form does not match', async () => {
    assert.strictEqual(
      await matches(URSALUNA, 'Pokemon Trading Card Game Prismatic Evolutions Elite Trainer Box'),
      false,
    );
  });

  test('sibling sets do not match — Pitch Black is not Perfect Order', async () => {
    assert.strictEqual(
      await matches(
        'Pokemon TCG: Mega Evolution Pitch Black Elite Trainer Box',
        'Pokemon TCG: Mega Evolution Perfect Order Elite Trainer Box',
      ),
      false,
    );
  });

  test('same set, different product — a Booster Bundle is not a Booster Box', async () => {
    assert.strictEqual(
      await matches('Pokemon TCG: Surging Sparks Booster Bundle', 'Pokemon TCG: Surging Sparks Booster Box'),
      false,
    );
  });

  test('boilerplate alone can never carry a match', async () => {
    // Nothing shared but the words every product in the catalogue has.
    assert.strictEqual(
      await matches('Pokemon Trading Card Game Chaos Rising Booster Box', 'Pokemon Trading Card Game Journey Together Booster Box'),
      false,
    );
  });
});

describe('cross-retailer: the same product still matches across retailers', () => {
  test('different wording for the same product', async () => {
    assert.strictEqual(await matches(URSALUNA, 'Pokemon TCG Bloodmoon Ursaluna ex Box'), true);
  });

  test('one retailer spelling out the parent set is not a different product', async () => {
    assert.strictEqual(
      await matches(
        'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
        'Pokemon Scarlet & Violet Prismatic Evolutions Elite Trainer Box',
      ),
      true,
    );
  });

  test('identical names match', async () => {
    assert.strictEqual(await matches(URSALUNA, URSALUNA), true);
  });
});
