/**
 * Which URL the sweep asks for is the only thing that changes how many requests this store sees.
 *
 * Probe 5 (2026-09-16) asked for ?ps=96 on a plain navigation and got 95 products back in a
 * single load, against the store's default of 32. The measured headed sweep needed 5 pages to
 * cover 129 products; at 96 that is 2. Reading those products out of __NEXT_DATA__ instead of the
 * rendered tiles saves NO requests at all -- it is the same page load -- so this parameter, not
 * the parser, is what the rate limit responds to.
 *
 * The other half of that finding is a trap, and it is why the sweep builds a URL rather than
 * driving the control: selecting 96 through the site's own "Items per page" menu fired the
 * DataDome-protected /tpci-ecommweb-api/search endpoint, which returned 403 and drew a captcha,
 * while every plain document navigation in the same runs rendered cleanly.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { pcCategoryUrl } = require('../src/adapters/pokemoncenter');

const BASE = 'https://www.pokemoncenter.com/en-ca/category/trading-card-game';

describe('pcCategoryUrl', () => {
  test('page 1 carries no page parameter — the URL a shopper actually lands on', () => {
    assert.strictEqual(pcCategoryUrl(BASE, 1, 96), `${BASE}?ps=96`);
  });

  test('later pages carry both, in the order the site writes them', () => {
    assert.strictEqual(pcCategoryUrl(BASE, 2, 96), `${BASE}?page=2&ps=96`);
    assert.strictEqual(pcCategoryUrl(BASE, 8, 96), `${BASE}?page=8&ps=96`);
  });

  // PC_PAGE_SIZE=0 is the escape hatch if the cadence work ever wants the store's own default
  // back. It must drop the parameter, not send ps=0 and ask for an empty grid.
  test('a page size of zero omits ps entirely rather than sending ps=0', () => {
    assert.strictEqual(pcCategoryUrl(BASE, 1, 0), BASE);
    assert.strictEqual(pcCategoryUrl(BASE, 3, 0), `${BASE}?page=3`);
  });

  test('the default 32 can still be requested explicitly', () => {
    assert.strictEqual(pcCategoryUrl(BASE, 1, 32), `${BASE}?ps=32`);
  });

  test('it builds a URL and never a click — always parseable, always a navigation', () => {
    const u = new URL(pcCategoryUrl(BASE, 4, 96));
    assert.strictEqual(u.searchParams.get('page'), '4');
    assert.strictEqual(u.searchParams.get('ps'), '96');
    assert.strictEqual(u.pathname, '/en-ca/category/trading-card-game');
  });
});

describe('the size the sweep actually ships with', () => {
  // This is the number that decides the store's request count. Asserting it directly means a
  // change to the default has to be deliberate, rather than silently tripling the page loads.
  const { PC_PAGE_SIZE } = require('../src/adapters/pokemoncenter');

  test('defaults to 96, the largest the store offers', () => {
    assert.strictEqual(PC_PAGE_SIZE, 96);
  });

  test('and that is what a swept page 1 asks for', () => {
    assert.strictEqual(pcCategoryUrl(BASE, 1, PC_PAGE_SIZE), `${BASE}?ps=96`);
  });
});
