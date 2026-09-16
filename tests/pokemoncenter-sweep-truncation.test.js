/**
 * A REFUSED page is not the end of a category.
 *
 * MEASURED, 2026-09-17. A paced run of trading-card-game at ?ps=96, three pages, 60s apart:
 *
 *   page 1   403 on the document, rendered anyway, 95 products
 *   page 2   200, 96 products (33 in stock, 63 sold out)
 *   page 3   403, TWO requests in total, zero bytes of __NEXT_DATA__, no app at all
 *
 * Page 3 was not the end of the catalogue. Page 8 at ?ps=32 carried 34 tiles on 2026-09-13, so
 * the category holds at least 258 products and page 3 at 96 was owed roughly 66 of them. The
 * sweep's old rule -- break when the tile count is zero -- would have stopped there, reported
 * success, and silently dropped a third of the store. That exact failure is already on the record
 * in the adapter (a 6-page sweep reported 129 products and stopped at page 5 while pages 5 and 8
 * plainly carried 34 each).
 *
 * __NEXT_DATA__ separates the two cases for free. It is server-rendered and present before
 * hydration, so an ENDED category still ships it carrying an empty product array, while a refused
 * page ships no app at all. Only the COUNT is used here, never a stock verdict, so this is fully
 * compatible with the observe-only stance on `outOfStock`.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;
state.getAllProducts = async () => ({});

const PokemonCenter = require('../src/adapters/pokemoncenter');
const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;
const logger = require('../src/monitoring/logger');

const wrap = (products) =>
  JSON.stringify({ props: { initialState: { search: { results: { products } } } } });

const product = (code, outOfStock) => ({
  code, name: `Product ${code}`, outOfStock,
  purchasePrice: { amount: 20.99, display: '$20.99' },
});

/** The three shapes a category page can come back as. */
const PAGE = {
  full: (n) => wrap(Array.from({ length: 96 }, (_, i) => product(`p${n}-${i}`, false))),
  ended: () => wrap([]),
  refused: () => null,          // 403 with no app: exactly what page 3 returned
};

let adapter;
let lines;
beforeEach(() => {
  adapter = new PokemonCenter(list.find((r) => r.id === 'pokemoncenter'));
  lines = [];
});

function capture(fn) {
  const origInfo = logger.info;
  const origWarn = logger.warn;
  logger.info = (m) => lines.push(String(m));
  logger.warn = (m) => lines.push(String(m));
  return Promise.resolve().then(fn).finally(() => { logger.info = origInfo; logger.warn = origWarn; });
}

/** Only `page.evaluate` is used by the cross-check, and only for the __NEXT_DATA__ text. */
const pageServing = (nextDataText) => ({ evaluate: async () => nextDataText });

describe('the cross-check reports whether the document carried product data', () => {
  test('a full page returns its parsed products', async () => {
    let parsed;
    await capture(async () => { parsed = await adapter._crossCheckNextData(pageServing(PAGE.full(1)), 'tcg', 1, []); });
    assert.ok(parsed, 'a served page must be reported as served');
    assert.strictEqual(parsed.products.length, 96);
  });

  // The distinction the sweep now turns on.
  test('an ENDED category returns an empty product list, not null', async () => {
    let parsed;
    await capture(async () => { parsed = await adapter._crossCheckNextData(pageServing(PAGE.ended()), 'tcg', 3, []); });
    assert.ok(parsed, 'an ended category still served a document');
    assert.strictEqual(parsed.products.length, 0);
  });

  test('a REFUSED page returns null and says so', async () => {
    let parsed;
    await capture(async () => { parsed = await adapter._crossCheckNextData(pageServing(PAGE.refused()), 'tcg', 3, []); });
    assert.strictEqual(parsed, null);
    assert.match(lines.join('\n'), /no products array/);
    assert.match(lines.join('\n'), /nextData=absent/);
  });

  test('a page whose shape moved is refused too, not read as an empty catalogue', async () => {
    // 96 rows, every one of them unusable: the row-shape change that used to parse as zero.
    const renamed = wrap(Array.from({ length: 96 }, (_, i) => ({ productCode: `x${i}`, outOfStock: false })));
    let parsed;
    await capture(async () => { parsed = await adapter._crossCheckNextData(pageServing(renamed), 'tcg', 1, []); });
    assert.strictEqual(parsed, null, 'a shape change must never read as "the category is empty"');
  });

  test('it still cannot throw, whatever the page does', async () => {
    const hostile = { evaluate: async () => { throw new Error('page closed'); } };
    await capture(async () => {
      await assert.doesNotReject(adapter._crossCheckNextData(hostile, 'tcg', 1, []));
    });
  });
});

describe('the log distinguishes the two endings', () => {
  test('an ended category is reported as a real zero, not a failure', async () => {
    await capture(() => adapter._crossCheckNextData(pageServing(PAGE.ended()), 'tcg', 3, []));
    const out = lines.join('\n');
    assert.match(out, /json=0 tiles=0/);
    assert.doesNotMatch(out, /no products array/);
  });

  test('a refused page never prints a product count that could be mistaken for zero stock', async () => {
    await capture(() => adapter._crossCheckNextData(pageServing(PAGE.refused()), 'tcg', 3, []));
    assert.doesNotMatch(lines.join('\n'), /json=0 /);
  });

  test('the payload identity is logged, so a frozen __NEXT_DATA__ is visible', async () => {
    await capture(() => adapter._crossCheckNextData(pageServing(PAGE.full(2)), 'tcg', 2, []));
    assert.match(lines.join('\n'), /first=p2-0/);
  });

  test('a partial shape change is counted rather than silently shrinking the page', async () => {
    const mixed = wrap([product('good-1', false), { name: 'no code' }, { code: 7 }]);
    await capture(() => adapter._crossCheckNextData(pageServing(mixed), 'tcg', 1, []));
    assert.match(lines.join('\n'), /dropped\(json\)=2/);
  });
});
