const { test, describe } = require('node:test');
const assert = require('node:assert');

// Mirrors the title-restoration rule in amazon.js _parseSearchHtml.
function restoreTitle(aria, alt) {
  let name = aria;
  if (alt) {
    const prefixLen = alt.length - aria.length;
    if (prefixLen > 0 && prefixLen <= 30 && alt.endsWith(aria)) name = alt;
  }
  return name;
}

describe('amazon: title restoration is safe by construction', () => {
  test('restores the dropped accented brand prefix', () => {
    const aria = 'TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    const alt = 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    assert.strictEqual(restoreTitle(aria, alt), alt);
  });

  test('ignores a neighbouring product alt entirely', () => {
    // Observed live: the s-image alt in a card slice belonging to another sponsored item.
    const aria = 'The World Game - Geography Card Game - Educational Board Game';
    const alt = 'Sponsored Ad – 9-Pocket Top Loader Binder, 216 Cards, Zipper';
    assert.strictEqual(restoreTitle(aria, alt), aria, 'must keep the card its own title');
  });

  test('ignores an alt that merely shares a prefix rather than extending it', () => {
    const aria = 'Sponsored Ad – Card Display Stand, 6-Tier Trading Card Display';
    const alt = 'Sponsored Ad – Emfogo Card Display Stand, 6-Tier Trading Card';
    assert.strictEqual(restoreTitle(aria, alt), aria);
  });

  test('ignores an implausibly long prefix', () => {
    const aria = 'Booster Box';
    const alt = 'Some Very Long Unrelated Marketing Preamble That Is Not A Brand Booster Box';
    assert.strictEqual(restoreTitle(aria, alt), aria);
  });

  test('keeps aria when no alt is present', () => {
    assert.strictEqual(restoreTitle('Pokemon TCG Booster Bundle', undefined), 'Pokemon TCG Booster Bundle');
  });

  test('identical alt changes nothing', () => {
    const t = 'Pokemon TCG: Mega Evolution Pitch Black Sleeved Booster';
    assert.strictEqual(restoreTitle(t, t), t);
  });

  test('restoring the prefix is what lets the classifier see the franchise', () => {
    const { classifyCategory } = require('../src/utils/helpers');
    const { categories } = require('../src/config/products.json');
    const aria = 'TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    const alt = 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    // The stripped title only classifies via a set-name keyword; the restored one names the
    // franchise outright, which is what stops these landing in 'other' and being dropped.
    assert.strictEqual(classifyCategory(restoreTitle(aria, alt), categories), 'pokemon');
    assert.ok(restoreTitle(aria, alt).toLowerCase().includes('pok'), 'franchise word present');
  });
});
