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
  buildActionRequest,
  fetchStoreAvailability,
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

  test('a missing stockAvailable reads as zero, never as unknown-in-stock', () => {
    const [row] = parseStoreResponse(flight([{ ...GRANVILLE, stockAvailable: undefined }]));
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
  });

  test('nothing in stock renders nothing, rather than "unavailable"', () => {
    assert.strictEqual(formatStoreField(parseStoreResponse(flight([OLYMPIC]))), null,
      'a lookup that found no stock must omit the field — we may simply have missed it, and ' +
      'stating absence as fact would be a wrong field');
    assert.strictEqual(formatStoreField([]), null);
  });
});

describe('the request we send', () => {
  test('carries the product code and postal code the site sends', () => {
    const req = buildActionRequest('https://www.londondrugs.com/products/x/p/L3293797', 'L3293797', 'V6B 1A1');
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.body, '["L3293797",{"zipCode":"V6B 1A1"}]');
    assert.match(req.headers['Next-Action'], /^[0-9a-f]{40}$/);
    assert.strictEqual(req.headers['Content-Type'], 'text/plain;charset=UTF-8');
  });
});

describe('the enrichment loop', () => {
  function fakeSession(handler) {
    const calls = [];
    let closed = false;
    return {
      calls,
      wasClosed: () => closed,
      open: async () => ({
        post: async (req) => { calls.push(req); return handler(req); },
        close: async () => { closed = true; },
      }),
    };
  }

  test('one session serves every product and postal code', async () => {
    const s = fakeSession(() => flight([GRANVILLE]));
    const out = await fetchStoreAvailability(
      [{ sku: 'A', url: 'u/A' }, { sku: 'B', url: 'u/B' }],
      { openSession: s.open, postalCodes: ['V6B 1A1', 'T2P 1J9'] },
    );
    assert.strictEqual(s.calls.length, 4, '2 products x 2 postal codes');
    assert.strictEqual(out.size, 2);
    assert.ok(s.wasClosed(), 'the session must be closed — these are billed per GB');
  });

  test('the same store returned for two postal codes is not duplicated', async () => {
    const s = fakeSession(() => flight([GRANVILLE]));
    const out = await fetchStoreAvailability([{ sku: 'A', url: 'u/A' }],
      { openSession: s.open, postalCodes: ['V6B 1A1', 'T2P 1J9', 'S4P 3Y2'] });
    assert.strictEqual(out.get('A').length, 1, 'regions overlap; a store must appear once');
  });

  test('one product failing does not lose the others', async () => {
    const s = fakeSession((req) => {
      if (req.body.includes('BAD')) throw new Error('boom');
      return flight([GRANVILLE]);
    });
    const out = await fetchStoreAvailability(
      [{ sku: 'BAD', url: 'u/BAD' }, { sku: 'GOOD', url: 'u/GOOD' }],
      { openSession: s.open, postalCodes: ['V6B 1A1'] },
    );
    assert.strictEqual(out.has('BAD'), false);
    assert.strictEqual(out.get('GOOD').length, 1);
    assert.ok(s.wasClosed());
  });

  test('the session is closed even when the loop throws', async () => {
    const s = fakeSession(() => { throw new Error('hard fail'); });
    await fetchStoreAvailability([{ sku: 'A', url: 'u/A' }], { openSession: s.open, postalCodes: ['V6B'] });
    assert.ok(s.wasClosed(), 'a leaked browser session bills until it times out');
  });

  test('no browser configured returns empty rather than throwing', async () => {
    const out = await fetchStoreAvailability([{ sku: 'A', url: 'u/A' }], {});
    assert.strictEqual(out.size, 0);
  });

  test('a session that will not open does not take the poll down with it', async () => {
    const out = await fetchStoreAvailability([{ sku: 'A', url: 'u/A' }],
      { openSession: async () => { throw new Error('bright data down'); } });
    assert.strictEqual(out.size, 0);
  });
});
