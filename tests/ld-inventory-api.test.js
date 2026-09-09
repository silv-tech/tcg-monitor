/**
 * London Drugs per-store stock, read from the plain inventory endpoint.
 *
 * This replaces a Next.js server action that needed a `Next-Action` header and a Bright Data
 * browser session. Two things make the replacement worth pinning down:
 *
 *   1. The `locationCodes` parameter. WITHOUT it the endpoint silently caps at 50 rows — store
 *      codes 002..056 — hiding 28 stores including every store in Saskatchewan and Manitoba.
 *      Measured on L3445613 (30th Celebration Tech Sticker Collection) on 2026-09-09: 46 stores
 *      in stock nationally, 17 of them above the cap holding 924 of 2,628 units. A third of the
 *      country's stock read as zero. The SINGULAR `locationCode` is ignored, which is what made
 *      an earlier probe conclude the cap could not be moved.
 *
 *   2. The join. `locationCode` IS the store id in /stores/<slug>/s/<NNN> — an identity, not an
 *      offset. An earlier attempt joined by matching quantities instead and mislabelled store 030
 *      as North Town Centre, Edmonton; it is Heritage Plaza, Calgary. Six stores held exactly 40
 *      units of that product, so quantity was never identifying. Ground truth below comes from a
 *      competitor's alerts, which name the store AND the count.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  buildInventoryUrl, parseInventoryRows, fetchInventory, totalUnits,
  storesWithStock, formatStoreField, ALL_LOCATION_CODES, STORE_MAP,
} = require('../src/utils/ld-store-availability');

const resp = (rows) => JSON.stringify({ isSuccess: true, errors: [], data: rows });
const row = (locationCode, stockAvailable) => ({ productCode: 'L3445613', locationCode, stockAvailable, softStockAvailable: null });

describe('the request asks for every store', () => {
  test('the URL uses the PLURAL parameter — the singular one is ignored by the endpoint', () => {
    const u = buildInventoryUrl('L3445613');
    assert.match(u, /[?&]locationCodes=/, 'locationCode (singular) returns the capped 50 rows');
  });

  test('stores above the 50-row cap are requested — the regression that hid a third of the stock', () => {
    const u = buildInventoryUrl('L3445613');
    for (const code of ['068', '092', '062', '066', '751']) {
      assert.ok(u.includes(code), `store ${code} must be requested; without it Royal Oak, Polo Park, Saskatoon and St. Vital read as zero`);
    }
  });

  test('every store we know about is asked for', () => {
    assert.strictEqual(ALL_LOCATION_CODES.length, Object.keys(STORE_MAP).length);
    assert.ok(ALL_LOCATION_CODES.length >= 78, `expected the full chain, got ${ALL_LOCATION_CODES.length}`);
  });

  test('an explicit subset is honoured, so a single store can be probed', () => {
    assert.match(buildInventoryUrl('L3445613', ['068']), /locationCodes=068$/);
  });
});

describe('rows join to real stores', () => {
  test('ground truth: 021 is North Town Centre, Edmonton', () => {
    const [r] = parseInventoryRows(resp([row('021', 40)]));
    assert.strictEqual(r.name, 'North Town Centre');
    assert.strictEqual(r.city, 'Edmonton');
    assert.strictEqual(r.stockAvailable, 40);
  });

  test('ground truth: 068 is Royal Oak Centre, Calgary — a store the capped response never returned', () => {
    const [r] = parseInventoryRows(resp([row('068', 72)]));
    assert.strictEqual(r.name, 'Royal Oak Centre');
    assert.strictEqual(r.city, 'Calgary');
    assert.strictEqual(r.stockAvailable, 72);
  });

  test('030 is Heritage Plaza, Calgary — NOT North Town Centre', () => {
    const [r] = parseInventoryRows(resp([row('030', 40)]));
    assert.strictEqual(r.name, 'Heritage Plaza');
    assert.strictEqual(r.city, 'Calgary');
  });

  test('an unknown store code keeps its stock but is never given a name', () => {
    const [r] = parseInventoryRows(resp([row('999', 12)]));
    assert.strictEqual(r.stockAvailable, 12, 'dropping it would understate national stock');
    assert.strictEqual(r.name, null, 'a wrong store name is worse than no store name');
  });

  test('a non-numeric quantity reads as zero, never as stock', () => {
    const [r] = parseInventoryRows(resp([{ locationCode: '021', stockAvailable: 'many' }]));
    assert.strictEqual(r.stockAvailable, 0);
  });

  test('garbage in yields no rows rather than throwing', () => {
    for (const bad of ['', 'not json', '{}', '{"data":null}', '{"data":{}}', null, undefined, '[]']) {
      assert.deepStrictEqual(parseInventoryRows(bad), [], `failed on ${JSON.stringify(bad)}`);
    }
  });
});

describe('a failed lookup is not an out-of-stock report', () => {
  test('a throwing fetcher yields no rows, leaving prior state untouched', async () => {
    const rows = await fetchInventory('L3445613', { fetcher: async () => { throw new Error('403'); } });
    assert.deepStrictEqual(rows, [], 'a blocked request must never read as "gone from every store"');
  });

  test('a missing fetcher is refused rather than guessed at', async () => {
    assert.deepStrictEqual(await fetchInventory('L3445613', {}), []);
  });

  test('a good fetcher returns joined rows', async () => {
    const rows = await fetchInventory('L3445613', { fetcher: async () => resp([row('068', 72), row('021', 40)]) });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.find((r) => r.code === '068').name, 'Royal Oak Centre');
  });
});

describe('totals and presentation', () => {
  test('totalUnits sums only real stock', () => {
    assert.strictEqual(totalUnits(parseInventoryRows(resp([row('021', 40), row('068', 72), row('030', 0)]))), 112);
    assert.strictEqual(totalUnits([]), 0);
    assert.strictEqual(totalUnits(null), 0);
  });

  test('with no geography, the embed names the store holding the MOST units', () => {
    const rows = parseInventoryRows(resp([row('021', 40), row('068', 72), row('030', 12)]));
    assert.strictEqual(storesWithStock(rows)[0].name, 'Royal Oak Centre');
    const field = formatStoreField(rows);
    assert.match(field, /Royal Oak Centre/);
    assert.match(field, /72 in stock/);
    assert.match(field, /\+2 other stores in stock/);
  });

  test('nothing in stock renders nothing at all', () => {
    assert.strictEqual(formatStoreField(parseInventoryRows(resp([row('021', 0), row('068', 0)]))), null,
      'an empty result must not claim the product is unavailable — we may simply have failed to read it');
  });
});

describe('the store map is fit to print', () => {
  test('no store carries an encoding artefact', () => {
    // Three names arrived double-encoded from the site's Flight payload and would have rendered
    // in Discord as "Granville & Georgia". A store name goes straight into a customer-facing
    // embed, so a mangled one is a wrong value, not a cosmetic issue.
    const BS = String.fromCharCode(92);
    const artefact = new RegExp(`${BS}${BS}u[0-9a-fA-F]{4}|&amp;|&#|&quot;`);
    for (const [code, s] of Object.entries(STORE_MAP)) {
      assert.ok(!artefact.test(JSON.stringify(s)), `store ${code} has an encoding artefact: ${s.name}`);
    }
  });

  test('every store has the fields an alert needs', () => {
    for (const [code, s] of Object.entries(STORE_MAP)) {
      for (const f of ['name', 'address1', 'city', 'province']) {
        assert.ok(s[f] && String(s[f]).trim(), `store ${code} is missing ${f}`);
      }
    }
  });

  test('the two ground-truth stores are intact', () => {
    assert.strictEqual(STORE_MAP['021'].name, 'North Town Centre');
    assert.strictEqual(STORE_MAP['021'].city, 'Edmonton');
    assert.strictEqual(STORE_MAP['068'].name, 'Royal Oak Centre');
    assert.strictEqual(STORE_MAP['068'].city, 'Calgary');
  });
});
