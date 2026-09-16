/**
 * The __NEXT_DATA__ cross-check is a MEASUREMENT, not a switch.
 *
 * Probe 3 (2026-09-15, one load of trading-card-game through the Railway residential exit) found
 * the grid's products inside the document at $.props.initialState.search.results.products, each
 * carrying a boolean `outOfStock`, structured prices and a clean SKU. That is strictly better
 * evidence than tile innerText, and it costs no extra request — Probe 1 established that NO XHR
 * fills the grid, so this is the same document the sweep already loads.
 *
 * It is still not the source of truth, and these tests pin why. That page had 31 of 31 products
 * IN STOCK, so `outOfStock: true` has never been observed on this store. The Amazon seller gate
 * went blind on exactly this kind of reasonable-looking assumption. Until one sweep reaches a
 * sold-out page, the cross-check logs agreement and changes nothing.
 *
 * What these tests guarantee: the cross-check reads, compares and reports, and CANNOT take down
 * the sweep it is measuring or alter a single stored row.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const PokemonCenter = require('../src/adapters/pokemoncenter');
const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;
const adapter = new PokemonCenter(list.find((r) => r.id === 'pokemoncenter'));

const logger = require('../src/monitoring/logger');

/** A stand-in for the Playwright page: all the cross-check uses is page.evaluate(). */
const pageWith = (nextDataText) => ({
  evaluate: async () => nextDataText,
});

const product = (code, outOfStock, price = 53.99) => ({
  code,
  name: `Product ${code}`,
  outOfStock,
  purchasePrice: { amount: price, display: `$${price}` },
  images: [{ original: `https://img/${code}.jpg`, thumbnail: '', high: '' }],
  releaseDate: '2026-07-08T00:00:00Z',
  reportingCrumb: 'TRADING CARD GAME>TCG Accessories>Binders',
});

const nextData = (products) =>
  JSON.stringify({ props: { initialState: { search: { results: { products } } } } });

/** DOM tiles as pcExtractTiles returns them: a sku and the tile's collapsed innerText. */
const tile = (sku, text) => ({ sku, slug: `slug-${sku}`, text });

/** Run the cross-check with logging captured, and return everything it reported. */
async function runCheck(nextDataText, found, slug = 'trading-card-game', n = 1) {
  const lines = [];
  const origInfo = logger.info;
  const origWarn = logger.warn;
  logger.info = (m) => { lines.push(String(m)); };
  logger.warn = (m) => { lines.push(String(m)); };
  try {
    await adapter._crossCheckNextData(pageWith(nextDataText), slug, n, found);
  } finally {
    logger.info = origInfo;
    logger.warn = origWarn;
  }
  return lines.join('\n');
}

describe('JSONCHECK — what it measures', () => {
  test('agreement on in-stock products is counted, with no disagreement reported', async () => {
    const out = await runCheck(
      nextData([product('10-10320-101', false), product('10-10166-101', false)]),
      [tile('10-10320-101', 'Mewtwo Binder $53.99'), tile('10-10166-101', 'Pikachu Sleeves $20.99')],
    );
    assert.match(out, /json=2 tiles=2/);
    assert.match(out, /agree=2 differ=0/);
    assert.doesNotMatch(out, /DISAGREE/);
  });

  // The sold-out direction is the whole open question, so the check must be able to see it.
  test('a sold-out product agreeing with a SOLD OUT tile is counted as agreement', async () => {
    const out = await runCheck(
      nextData([product('10-10320-101', true)]),
      [tile('10-10320-101', 'Mewtwo Binder SOLD OUT $53.99')],
    );
    assert.match(out, /agree=1 differ=0/);
    assert.match(out, /soldOut\(json\)=1/);
  });

  test('a real disagreement is named, with the SKU and both verdicts', async () => {
    const out = await runCheck(
      nextData([product('10-10320-101', true)]),
      [tile('10-10320-101', 'Mewtwo Binder $53.99')],     // tile says buyable, JSON says sold out
    );
    assert.match(out, /differ=1/);
    assert.match(out, /DISAGREE: 10-10320-101 dom=true json=false/);
  });

  /**
   * The finding that motivated the whole module. `a[href*="/en-ca/product/"]` also matches the
   * mega-menu's own product links, so the tile selector cannot tell a grid tile from a nav item.
   * Probe 3 returned 33 anchors for 31 products; the two extras, 716E11935 and 715E10557, do not
   * even share the grid's SKU format and were exactly the two tiles pcVerdict() had to refuse.
   */
  test('mega-menu links show up as domOnly and are named', async () => {
    const out = await runCheck(
      nextData([product('10-10320-101', false)]),
      [
        tile('10-10320-101', 'Mewtwo Binder $53.99'),
        tile('716E11935', 'Some Menu Feature'),
        tile('715E10557', 'Another Menu Feature'),
      ],
    );
    assert.match(out, /json=1 tiles=3/);
    assert.match(out, /domOnly=2/);
    assert.match(out, /716E11935/);
    assert.match(out, /715E10557/);
  });

  test('unreadable on either side is skipped, never counted as agreement', async () => {
    const noField = { code: '10-10320-101', name: 'x' };          // JSON refuses
    const out = await runCheck(
      nextData([noField]),
      [tile('10-10320-101', 'no price, no badge')],               // tile refuses too
    );
    assert.match(out, /agree=0 differ=0/);
    assert.match(out, /unreadable\(json\)=1/);
  });
});

describe('JSONCHECK — an absent array is not an empty catalogue', () => {
  test('a missing products array is reported as a shape miss, not as zero products', async () => {
    const out = await runCheck('{"props":{}}', [tile('10-10320-101', 'Mewtwo Binder $53.99')]);
    assert.match(out, /no products array/);
    assert.doesNotMatch(out, /json=0 /);
  });

  test('no __NEXT_DATA__ at all says so explicitly', async () => {
    const out = await runCheck(null, [tile('10-10320-101', 'Mewtwo Binder $53.99')]);
    assert.match(out, /no products array/);
    assert.match(out, /nextData=absent/);
  });

  test('a genuinely empty category is reported as a real zero', async () => {
    const out = await runCheck(nextData([]), []);
    assert.match(out, /json=0 tiles=0/);
    assert.doesNotMatch(out, /no products array/);
  });
});

describe('JSONCHECK — cannot break the sweep it measures', () => {
  // A cross-check that throws would abort a sweep that was otherwise working, which is strictly
  // worse than having no cross-check at all.
  test('a page whose evaluate throws is caught and logged, not rethrown', async () => {
    const page = { evaluate: async () => { throw new Error('page closed'); } };
    const lines = [];
    const origInfo = logger.info;
    const origWarn = logger.warn;
    logger.info = (m) => { lines.push(String(m)); };
    logger.warn = (m) => { lines.push(String(m)); };
    try {
      await assert.doesNotReject(
        adapter._crossCheckNextData(page, 'trading-card-game', 1, []),
      );
    } finally {
      logger.info = origInfo;
      logger.warn = origWarn;
    }
    // The evaluate() rejection is absorbed by the inner .catch(() => null), so it reads as an
    // absent __NEXT_DATA__ rather than a crash. Either way: no throw, and something is logged.
    assert.ok(lines.join('\n').length > 0);
  });

  test('garbage in the tile list does not throw', async () => {
    await assert.doesNotReject(runCheck(nextData([product('10-10320-101', false)]), []));
  });

  test('it stores nothing — availability is untouched by a cross-check', async () => {
    const before = adapter.availabilityCache.size;
    await runCheck(
      nextData([product('10-10320-101', false), product('10-99999-101', true)]),
      [tile('10-10320-101', 'Mewtwo Binder $53.99')],
    );
    assert.strictEqual(adapter.availabilityCache.size, before);
    assert.strictEqual(adapter.availabilityCache.has('10-99999-101'), false);
  });
});
