const assert = require('assert');
const { describe, it } = require('node:test');
const { classifyCategory, normalizePrice, hashSku, truncate } = require('../src/utils/helpers');

const categories = {
  pokemon: ['pokemon', 'pokémon', 'pikachu'],
  onepiece: ['one piece'],
  dragonball: ['dragon ball'],
  lorcana: ['lorcana'],
};

describe('classifyCategory', () => {
  it('detects pokemon', () => {
    assert.strictEqual(classifyCategory('Pokemon Scarlet & Violet Booster Box', categories), 'pokemon');
  });

  it('detects one piece', () => {
    assert.strictEqual(classifyCategory('One Piece OP-17 Booster Box', categories), 'onepiece');
  });

  it('returns other for unknown', () => {
    assert.strictEqual(classifyCategory('Magic the Gathering Box', categories), 'other');
  });

  it('case insensitive', () => {
    assert.strictEqual(classifyCategory('POKEMON ELITE TRAINER BOX', categories), 'pokemon');
  });
});

describe('normalizePrice', () => {
  it('parses dollar string', () => {
    assert.strictEqual(normalizePrice('$199.99'), 199.99);
  });

  it('parses string with CAD', () => {
    assert.strictEqual(normalizePrice('$49.99 CAD'), 49.99);
  });

  it('passes through numbers', () => {
    assert.strictEqual(normalizePrice(42.5), 42.5);
  });

  it('returns null for empty', () => {
    assert.strictEqual(normalizePrice(''), null);
    assert.strictEqual(normalizePrice(null), null);
  });

  it('returns null for non-numeric', () => {
    assert.strictEqual(normalizePrice('free'), null);
  });

  it('handles comma-separated thousands', () => {
    assert.strictEqual(normalizePrice('$1,299.99'), 1299.99);
  });
});

describe('hashSku', () => {
  it('creates retailer:sku key', () => {
    assert.strictEqual(hashSku('walmart', 'ABC123'), 'walmart:ABC123');
  });
});

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    assert.strictEqual(truncate('hello', 10), 'hello');
  });

  it('truncates long strings with ellipsis', () => {
    const long = 'a'.repeat(300);
    const result = truncate(long, 256);
    assert.strictEqual(result.length, 256);
    assert.ok(result.endsWith('...'));
  });

  it('handles empty/null', () => {
    assert.strictEqual(truncate(''), '');
    assert.strictEqual(truncate(null), '');
  });
});

// --- TCG-only scope: merchandise must never alert -------------------------------
{
  const { isTCGProduct, classifyCategory } = require('../src/utils/helpers');
  const { categories } = require('../src/config/products.json');
  const alerts = (n) => isTCGProduct(n) && ['pokemon', 'onepiece'].includes(classifyCategory(n, categories));

  const SEALED = [
    'Pokemon TCG 30th Celebration Elite Trainer Box',
    'Pokemon TCG Mega Evolution Pitch Black Booster Display Box',
    'Pokemon TCG 30th Celebration Booster Bundle 6 Packs',
    'Pokemon TCG 30th Celebration Knock Out Collection',
    'Pokemon TCG Mega Charizard Tin Mega Charizard X',
    'One Piece Card Game OP-09 Booster Box',
  ];
  // Pokemon Center titles merchandise "Pokemon TCG ..." even when it holds no cards.
  const MERCH = [
    'Pokemon TCG Celestial Espeon and Umbreon Bag Tag',
    'Pokemon TCG Celestial Espeon and Umbreon Convertible Shoulder Bag',
    'Pokemon TCG Mewtwo and Mew DNA Premium Zip Binder',
    'Pokemon TCG Opening Scene Playmat',
    'Pokemon TCG Deck Buddies Gengar Deck Box',
    'Pokemon TCG Pikachu Keychain',
    'Pokemon Pikachu Plush 8 inch',
  ];
  for (const n of SEALED) {
    if (!alerts(n)) { console.error(`FAIL: sealed product must alert -> ${n}`); process.exitCode = 1; }
  }
  for (const n of MERCH) {
    if (alerts(n)) { console.error(`FAIL: merchandise must NOT alert -> ${n}`); process.exitCode = 1; }
  }
  console.log(`TCG-only scope: ${SEALED.length} sealed alert, ${MERCH.length} merch blocked`);
}
