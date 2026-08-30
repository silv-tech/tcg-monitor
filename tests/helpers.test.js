const assert = require('assert');
const { describe, it } = require('node:test');
const { classifyCategory, classifyProductType, normalizePrice, hashSku, truncate } = require('../src/utils/helpers');

const categories = {
  pokemon: ['pokemon', 'pokémon', 'pikachu'],
  onepiece: ['one piece'],
  dragonball: ['dragon ball'],
  lorcana: ['lorcana'],
};

const productTypes = {
  'booster-box': ['booster box', 'booster display', 'display box'],
  'etb': ['elite trainer box', 'elite trainer', 'etb'],
  'tin': ['tin'],
  'blister': ['blister'],
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

describe('classifyProductType', () => {
  it('detects booster box', () => {
    assert.strictEqual(classifyProductType('Pokemon Booster Box 36 Packs', productTypes), 'booster-box');
  });

  it('detects ETB', () => {
    assert.strictEqual(classifyProductType('Scarlet & Violet Elite Trainer Box', productTypes), 'etb');
  });

  it('detects tin', () => {
    assert.strictEqual(classifyProductType('Pokemon 2024 Collectors Tin', productTypes), 'tin');
  });

  it('returns other for unknown type', () => {
    assert.strictEqual(classifyProductType('Some Random Product', productTypes), 'other');
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
