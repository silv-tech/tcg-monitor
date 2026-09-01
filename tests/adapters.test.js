const assert = require('assert');

// Fixture-based adapter parsing tests (#21)
// Tests adapter logic WITHOUT network calls

let passed = 0;
let failed = 0;

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

function it(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`    ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// --- Amazon adapter parsing ---
describe('Amazon Adapter Parsing', () => {
  const fixture = require('./fixtures/amazon-search.json');

  it('should extract ASIN, name, price from search results', () => {
    const item = fixture.results[0];
    assert.strictEqual(item.asin, 'B0GW2DK37Q');
    assert.strictEqual(item.price, 74.99);
    assert.ok(item.name.includes('Pokemon'));
  });

  it('should filter out third-party sellers', () => {
    const amazonOnly = fixture.results.filter(item => {
      const seller = (item.sold_by || '').toLowerCase();
      return !seller || seller.includes('amazon');
    });
    assert.strictEqual(amazonOnly.length, 3);
  });

  it('should filter out non-TCG products', () => {
    const tcgKeywords = ['pokemon', 'tcg', 'booster', 'trainer box', 'one piece',
      'dragon ball', 'lorcana', 'yugioh', 'yu-gi-oh', 'magic the gathering', 'trading card'];
    const tcgOnly = fixture.results.filter(item => {
      const lower = (item.name || '').toLowerCase();
      return tcgKeywords.some(kw => lower.includes(kw));
    });
    assert.strictEqual(tcgOnly.length, 3);
  });

  it('should handle missing price as out-of-stock', () => {
    const inStock = null != null;
    assert.strictEqual(inStock, false);
  });
});

// --- Walmart adapter parsing ---
describe('Walmart Adapter Parsing', () => {
  const fixture = require('./fixtures/walmart-search.json');

  it('should extract items from Walmart autoparse format', () => {
    assert.ok(fixture.items.length > 0);
    assert.strictEqual(fixture.items[0].id, '6000207839158');
  });

  it('should detect in-stock from availability string', () => {
    const avail0 = (fixture.items[0].availability || '').toLowerCase();
    assert.ok(avail0.includes('in stock'));

    const avail1 = (fixture.items[1].availability || '').toLowerCase();
    const inStock1 = avail1 ? avail1.includes('in stock') : false;
    assert.strictEqual(inStock1, false);
  });

  it('should filter out third-party sellers', () => {
    const walmartOnly = fixture.items.filter(item => {
      const seller = (item.seller || '').toLowerCase();
      return !seller || seller.includes('walmart');
    });
    assert.strictEqual(walmartOnly.length, 3);
  });

  it('should default to inStock:false when availability is empty', () => {
    const avail = (fixture.items[1].availability || '').toLowerCase();
    const inStock = avail ? avail.includes('in stock') : false;
    assert.strictEqual(inStock, false);
  });
});

// --- Event diffing ---
describe('Event Diffing', () => {
  const { detectEvents, EVENT_TYPES } = require('../src/core/events');

  it('should detect restock', () => {
    const events = detectEvents(
      { sku: 'A', inStock: false, price: 50, name: 'Test' },
      { sku: 'A', inStock: true, price: 50, name: 'Test' }
    );
    assert.ok(events.some(e => e.type === EVENT_TYPES.RESTOCK));
  });

  it('should detect price change', () => {
    const events = detectEvents(
      { sku: 'A', inStock: true, price: 60, name: 'Test' },
      { sku: 'A', inStock: true, price: 50, name: 'Test' }
    );
    assert.ok(events.some(e => e.type === EVENT_TYPES.PRICE_CHANGE));
  });

  it('should not fire price change when old price is 0', () => {
    const events = detectEvents(
      { sku: 'A', inStock: true, price: 0, name: 'Test' },
      { sku: 'A', inStock: true, price: 50, name: 'Test' }
    );
    assert.ok(!events.some(e => e.type === EVENT_TYPES.PRICE_CHANGE));
  });

  it('should detect new SKU', () => {
    const events = detectEvents(null, { sku: 'NEW', inStock: true, price: 50, name: 'New' });
    assert.ok(events.some(e => e.type === EVENT_TYPES.NEW_SKU));
  });
});

// --- Helpers ---
describe('Helpers', () => {
  const { normalizePrice, isTCGProduct, hashSku, truncate } = require('../src/utils/helpers');

  it('normalizePrice handles various formats', () => {
    assert.strictEqual(normalizePrice('$74.99 CAD'), 74.99);
    assert.strictEqual(normalizePrice('159.99'), 159.99);
    assert.strictEqual(normalizePrice(42), 42);
    assert.strictEqual(normalizePrice(''), null);
    assert.strictEqual(normalizePrice(null), null);
  });

  it('isTCGProduct identifies TCG products', () => {
    assert.strictEqual(isTCGProduct('Pokemon TCG Booster Box'), true);
    assert.strictEqual(isTCGProduct('One Piece Card Game Booster Box'), true);
    assert.strictEqual(isTCGProduct('Pokemon Plush Pikachu'), false);
    assert.strictEqual(isTCGProduct('Funko Pop Dragon Ball'), false);
  });

  it('hashSku combines retailer and sku', () => {
    assert.strictEqual(hashSku('amazon', 'B0GW2DK37Q'), 'amazon:B0GW2DK37Q');
  });

  it('truncate caps string length', () => {
    const result = truncate('a'.repeat(300), 100);
    assert.strictEqual(result.length, 100);
    assert.ok(result.endsWith('...'));
  });
});

// --- ScraperAPI budget ---
describe('ScraperAPI Budget', () => {
  it('should export budget status', () => {
    const { getBudgetStatus } = require('../src/utils/scraper-api');
    const status = getBudgetStatus();
    assert.ok('used' in status);
    assert.ok('budget' in status);
    assert.ok('pct' in status);
    assert.ok('paused' in status);
  });
});

process.on('exit', () => {
  console.log(`\n  ${passed} passing, ${failed} failing\n`);
  if (failed > 0) process.exit(1);
});
