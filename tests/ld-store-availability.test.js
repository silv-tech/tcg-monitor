/**
 * London Drugs per-store availability.
 *
 * The response is a real capture: the server action returns React Flight, not JSON, so the
 * store rows sit inside a `"data":[...]` island in a line like `1:{"isSuccess":true,...}`.
 * Parsing it wrong is the failure that matters — a wrong store or a wrong quantity in an embed
 * is worse than no store at all, and this retailer is pickup-only, so the address IS the alert.
 *
 * The browser session is injected, so this exercises the whole enrichment loop — dedupe across
 * postal codes, per-product failure isolation, session cleanup — without a network call.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  parseStoreResponse,
  storesWithStock,
  formatStoreField,


} = require('../src/utils/ld-store-availability');

// Shaped exactly like the captured response, including the Flight prefix line.
function flight(stores) {
  return '0:["$@1",["uXe4zU-CQY4L9UMOgneWk",null]]\n1:'
    + JSON.stringify({ isSuccess: true, errors: [], data: stores });
}

const GRANVILLE = {
  code: '002', locationCode: '002', name: 'Granville & Georgia', phone: '(604) 448-4802',
  address: { address1: '710 Granville Street', cityOrTown: 'Vancouver',
    stateOrProvince: 'British Columbia', postalOrZipCode: 'V6Z 1E4' },
  geo: { lat: 49.2824, lng: -123.11814 },
  stockAvailable: 1, safetyStock: 0, distance: 946.3959909387465,
};
const OLYMPIC = {
  code: '082', locationCode: '082', name: 'Olympic Village', phone: '(604) 448-4882',
  address: { address1: '1622 Salt Street', cityOrTown: 'Vancouver',
    stateOrProvince: 'British Columbia', postalOrZipCode: 'V5Y 0E4' },
  stockAvailable: 0, distance: 1480.2,
};
const FARTHER = {
  code: '090', locationCode: '090', name: 'Richmond Centre',
  address: { address1: '6551 No 3 Road', cityOrTown: 'Richmond',
    stateOrProvince: 'British Columbia', postalOrZipCode: 'V6Y 2B6' },
  stockAvailable: 4, distance: 9200,
};

describe('parsing the server-action response', () => {
  test('pulls store rows out of the Flight payload', () => {
    const rows = parseStoreResponse(flight([GRANVILLE, OLYMPIC]));
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0], {
      code: '002', name: 'Granville & Georgia', distanceM: 946.3959909387465,
      stockAvailable: 1, address1: '710 Granville Street', city: 'Vancouver',
      province: 'British Columbia', postal: 'V6Z 1E4', phone: '(604) 448-4802',
    });
  });

  test('nested objects do not truncate the array', () => {
    // geo/storeTiming/phoneNumbers are nested — a regex-based grab stops at the first "]".
    const rows = parseStoreResponse(flight([
      { ...GRANVILLE, storeTiming: { monday: { label: '8-10', hours: [1, [2, 3]] } },
        phoneNumbers: [{ service: 'Pharmacy', phone: 'x' }] },
      OLYMPIC,
    ]));
    assert.strictEqual(rows.length, 2, 'the second store was lost inside nested brackets');
  });

  test('garbage in never throws — it yields no stores', () => {
    for (const bad of ['', null, undefined, 'not json', '{"data":[', '{"data":[{oops}]}']) {
      assert.deepStrictEqual(parseStoreResponse(bad), [],
        `parse threw or invented data for ${JSON.stringify(bad)}`);
    }
  });

  test('a non-numeric stockAvailable reads as zero rather than as stock', () => {
    // The field being PRESENT but junk is a different case from it being absent: absent means
    // this is not a stock reading at all (see "payloads that are not store lists"), whereas
    // present-but-unparseable is a store we cannot count, which must never read as available.
    const [row] = parseStoreResponse(flight([{ ...GRANVILLE, stockAvailable: 'lots' }]));
    assert.strictEqual(row.stockAvailable, 0);
  });
});

describe('choosing which store to show', () => {
  test('only stores with units count, nearest first', () => {
    const hits = storesWithStock(parseStoreResponse(flight([FARTHER, OLYMPIC, GRANVILLE])));
    assert.deepStrictEqual(hits.map((s) => s.name), ['Granville & Georgia', 'Richmond Centre']);
  });

  test('the embed names the nearest store, its quantity and address', () => {
    const field = formatStoreField(parseStoreResponse(flight([GRANVILLE, OLYMPIC, FARTHER])));
    assert.match(field, /Granville & Georgia/);
    assert.match(field, /1 in stock/);
    assert.match(field, /710 Granville Street, Vancouver, British Columbia V6Z 1E4/);
    assert.match(field, /\+1 other store in stock/);
    // Distance is measured from the postal code we queried, not from the reader, so it is
    // true of the lookup and meaningless in the alert.
    assert.doesNotMatch(field, /km/, 'distance must not appear in the embed');
  });

  test('nothing in stock renders nothing, rather than "unavailable"', () => {
    assert.strictEqual(formatStoreField(parseStoreResponse(flight([OLYMPIC]))), null,
      'a lookup that found no stock must omit the field — we may simply have missed it, and ' +
      'stating absence as fact would be a wrong field');
    assert.strictEqual(formatStoreField([]), null);
  });
});

/**
 * The enrichment trigger on the adapter itself.
 *
 * _maybeEnrichStores runs at the TOP of the poll, before the catalogue is refreshed, so on the
 * first pass after a restart there is nothing to enrich yet. The first version stamped the
 * interval clock before working that out, so that empty pass consumed the whole 30 minutes and
 * store data never appeared in production at all — the alert shipped without the field it was
 * built for. A no-op must not spend the interval.
 */
describe('adapter enrichment trigger', () => {
  const LondonDrugs = require('../src/adapters/londondrugs');

  function adapter() {
    const a = new LondonDrugs({
      id: 'londondrugs', name: 'London Drugs', url: 'https://www.londondrugs.com',
      intervalMs: 30000, proxyTier: 'residential',
    });
    process.env.BRIGHTDATA_BROWSER_WS = 'wss://example.invalid:9222';
    // Persistence is Redis-backed; opening a connection here would hold the test process open
    // long after the assertions finish. These tests are about the trigger, not the store.
    a._saveStores = async () => {};
    a._loadStores = async () => {};
    return a;
  }

  test('an empty catalogue does not consume the enrichment interval', () => {
    const a = adapter();
    a._known.clear();
    a._maybeEnrichStores();
    assert.strictEqual(a._storesAt, 0,
      'the clock was stamped on a pass that did nothing — the next real chance is 30 minutes away');
    assert.strictEqual(a._storesRunning, false, 'a no-op must not leave the guard latched');
  });

  test('a catalogue with products does start a pass', () => {
    const scraperApi = require('../src/utils/scraper-api');
    const wasConfigured = scraperApi.isConfigured;
    const wasFetch = scraperApi.scraperFetch;
    scraperApi.isConfigured = () => true;
    scraperApi.scraperFetch = async () => JSON.stringify({ isSuccess: true, errors: [], data: [] });
    try {
      const a = adapter();
      a._known.set('L1', { sku: 'L1', url: 'https://x/p/L1', inStock: true });
      a._maybeEnrichStores();
      assert.ok(a._storesAt > 0, 'a real pass must stamp the clock so it is not repeated every poll');
    } finally {
      scraperApi.isConfigured = wasConfigured;
      scraperApi.scraperFetch = wasFetch;
    }
  });

  // This used to assert the opposite — that an out-of-stock catalogue was a no-op. That was the
  // bug: London Drugs is pickup-only, so shelf stock is independent of the website, and the two
  // 30th Celebration SKUs we missed had no online stock and no product page at all.
  test('an OUT-OF-STOCK catalogue still starts a pass — shelf stock is independent of the website', () => {
    const scraperApi = require('../src/utils/scraper-api');
    const wasConfigured = scraperApi.isConfigured;
    const wasFetch = scraperApi.scraperFetch;
    scraperApi.isConfigured = () => true;
    scraperApi.scraperFetch = async () => JSON.stringify({ isSuccess: true, errors: [], data: [] });
    try {
      const a = adapter();
      a._known.set('L1', { sku: 'L1', url: null, inStock: false });
      a._maybeEnrichStores();
      assert.ok(a._storesAt > 0,
        'skipping these is exactly how in-store-only drops went unnoticed');
    } finally {
      scraperApi.isConfigured = wasConfigured;
      scraperApi.scraperFetch = wasFetch;
    }
  });

  test('with no scraper transport the pass is skipped and the clock is kept', () => {
    const a = adapter();
    a._known.set('L1', { sku: 'L1', url: 'https://x/p/L1', inStock: true });
    a._maybeEnrichStores();
    assert.strictEqual(a._storesAt, 0, 'a pass that cannot run must not burn the interval');
  });
});

/**
 * A payload from the WRONG route must yield nothing, not plausible zeros.
 *
 * Server actions are route-scoped. The enrichment seeded its browser session on the homepage
 * and posted the product action from there; Next.js answered with a different payload whose
 * first `"data":[...]` array parsed into rows with no stockAvailable — which defaulted to 0.
 * Production then logged a confident "9/9 products" while every alert silently lost its store
 * field. Zeros that look like real data are worse than an empty result, because nothing
 * upstream can tell they are wrong.
 */
describe('payloads that are not store lists', () => {
  test('a data[] of something else yields no stores', () => {
    const notStores = '1:' + JSON.stringify({ isSuccess: true, data: [
      { id: 'nav-1', label: 'Shop by Category', url: '/category' },
      { id: 'nav-2', label: 'Deals & Events', url: '/deals' },
    ] });
    assert.deepStrictEqual(parseStoreResponse(notStores), [],
      'navigation rows were accepted as stores with 0 stock');
  });

  test('a store row missing stockAvailable entirely is not invented as zero', () => {
    const partial = '1:' + JSON.stringify({ data: [
      { locationCode: '002', name: 'Granville & Georgia',
        address: { address1: '710 Granville Street' } }, // no stockAvailable
    ] });
    assert.deepStrictEqual(parseStoreResponse(partial), [],
      'a row without a stock field is not a stock reading');
  });

  test('real store rows still parse', () => {
    const rows = parseStoreResponse(flight([GRANVILLE]));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].stockAvailable, 1);
  });
});

/**
 * The "+N other stores" count must describe reality, not the cache.
 *
 * It is derived from the rows handed to the embed, so truncating the cache silently truncates
 * the claim: a product genuinely in stock at 16 stores announced "+4 other stores in stock"
 * because only 5 rows were kept. Understating is still a wrong number, and a wrong number in
 * an alert is worse than a missing one.
 */
describe('the other-stores count', () => {
  function storesWithUnits(n) {
    return Array.from({ length: n }, (_, i) => ({
      code: String(100 + i), locationCode: String(100 + i), name: `Store ${i}`,
      address: { address1: `${i} Main Street`, cityOrTown: 'Vancouver',
        stateOrProvince: 'British Columbia', postalOrZipCode: 'V6Z 1E4' },
      stockAvailable: 1 + i, distance: 1000 * (i + 1),
    }));
  }

  test('counts every store that has stock', () => {
    const field = formatStoreField(parseStoreResponse(flight(storesWithUnits(16))));
    assert.match(field, /\+15 other stores in stock/,
      'the count must reflect all 16 stores with stock, not a truncated sample');
  });

  test('one store alone adds no count at all', () => {
    const field = formatStoreField(parseStoreResponse(flight(storesWithUnits(1))));
    assert.doesNotMatch(field, /other store/);
  });

  test('two stores says "store", not "stores"', () => {
    const field = formatStoreField(parseStoreResponse(flight(storesWithUnits(2))));
    assert.match(field, /\+1 other store in stock/);
  });
});
