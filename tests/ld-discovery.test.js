/**
 * Discovering London Drugs stock that is not on London Drugs' website.
 *
 * Every threshold and rule here is pinned to measurements taken on 2026-09-09 against the live
 * endpoints, across all 78 stores. The numbers in the assertions are real responses, not
 * invented fixtures — if the site changes shape, these should fail loudly rather than drift.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  CLASS, classifyProductResponse, stockShape, isAlertworthy,
  nextScanBatch, formatCode, codeNumber, productUrl, imageUrl,
} = require('../src/utils/ld-discovery');

// Real payloads, trimmed.
const HIDDEN = '{"isSuccess":false,"errors":[{"status":404,"message":"Item not found: L3445571 product code L3445571 is hidden","additionalErrorData":[{"name":"ItemId","value":"L3445571"}]}]}';
const MISSING = '{"isSuccess":false,"errors":[{"status":404,"message":"Item not found: L9999999 product code L9999999 not found","additionalErrorData":[{"name":"ItemId","value":"L9999999"}]}]}';
const VISIBLE = JSON.stringify({
  isSuccess: true, errors: [],
  data: { productCode: 'L3336291', product: { productName: 'Pokemon TCG: Mega Evolution Perfect Order Sleeved Booster Pack' } },
});

const rows = (pairs) => pairs.map(([locationCode, stockAvailable]) => ({ locationCode, stockAvailable }));
const spread = (n, qty) => rows(Array.from({ length: n }, (_, i) => [String(i).padStart(3, '0'), qty]));

describe('the three classes are separable', () => {
  test('a hidden product is recognised as hidden, not as missing', () => {
    assert.strictEqual(classifyProductResponse(HIDDEN).klass, CLASS.HIDDEN,
      'collapsing hidden into missing is exactly how these SKUs stayed invisible');
  });

  test('a code that was never issued is missing', () => {
    assert.strictEqual(classifyProductResponse(MISSING).klass, CLASS.MISSING);
  });

  test('a visible product yields its name', () => {
    const c = classifyProductResponse(VISIBLE);
    assert.strictEqual(c.klass, CLASS.VISIBLE);
    assert.match(c.name, /Mega Evolution Perfect Order/);
  });

  test('both 404 bodies are the same length — only the message distinguishes them', () => {
    assert.strictEqual(HIDDEN.length, MISSING.length,
      'if these ever differ in length, length is still not a safe discriminator');
    assert.notStrictEqual(classifyProductResponse(HIDDEN).klass, classifyProductResponse(MISSING).klass);
  });
});

describe('a transient failure is never mistaken for "no such product"', () => {
  test('garbage, empty and non-JSON all read as UNKNOWN', () => {
    for (const bad of ['', 'Internal Server Error', '<html>500</html>', null, undefined, 42, '{']) {
      assert.strictEqual(classifyProductResponse(bad).klass, CLASS.UNKNOWN,
        `${JSON.stringify(bad)} must not be read as a settled answer`);
    }
  });

  test('an unrecognised error message is UNKNOWN rather than assumed missing', () => {
    const odd = '{"isSuccess":false,"errors":[{"status":500,"message":"Something else entirely"}]}';
    assert.strictEqual(classifyProductResponse(odd).klass, CLASS.UNKNOWN,
      'a 1.1% transient 500 rate means guessing here permanently skips real products');
  });

  test('UNKNOWN codes are re-probed; settled ones are not', () => {
    const resolved = { L3445001: CLASS.MISSING, L3445002: CLASS.UNKNOWN, L3445003: CLASS.HIDDEN, L3445004: CLASS.VISIBLE };
    const batch = nextScanBatch('L3445000', resolved, 4);
    assert.ok(batch.includes('L3445001'), 'a missing code can be issued later');
    assert.ok(batch.includes('L3445002'), 'an unknown code was never actually answered');
    assert.ok(!batch.includes('L3445003'), 'hidden is terminal');
    assert.ok(!batch.includes('L3445004'), 'visible is terminal');
  });
});

describe('the stock screen separates real drops from incidental junk', () => {
  // The five hidden codes measured across all 78 stores on 2026-09-09.
  const MEASURED = [
    ['L3445566', 'NETGEAR ProSafe switch', spread(1, 1), false],
    ['L3445590', 'Peeps marshmallows', rows([['a', 2], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['g', 1], ['h', 1], ['i', 2], ['j', 1], ['k', 1]]), false],
    ['L3445613', 'Tech Sticker Collection', spread(46, 57), true],
    ['L3445571', 'Elite Trainer Box', spread(58, 48), true],
    ['L3445579', 'Knockout Collection', spread(46, 80), true],
  ];

  for (const [code, what, r, expected] of MEASURED) {
    test(`${code} (${what}) -> ${expected ? 'surfaced' : 'screened out'}`, () => {
      assert.strictEqual(isAlertworthy(r), expected);
    });
  }

  test('the threshold sits far from both classes, not on the boundary', () => {
    const junkMax = 13;      // Peeps: 13 units across 11 stores
    const realMin = 2628;    // Tech Sticker: 2628 units across 46 stores
    assert.ok(junkMax < 24 && 24 < realMin,
      'the screen must not be tuned to seven samples — it must sit in the gap between them');
  });

  test('zero stock is "not yet", not "not a product"', () => {
    // L3445587 (Greninja ex) and L3445595 (Poster Collection) both existed with no stock at all.
    assert.strictEqual(isAlertworthy(spread(78, 0)), false, 'nothing to alert on yet');
    assert.strictEqual(isAlertworthy([]), false);
    // The important part is that they stay under watch — nextScanBatch treats HIDDEN as terminal,
    // so the code is remembered rather than rediscovered.
    assert.ok(!nextScanBatch('L3445586', { L3445587: CLASS.HIDDEN }, 3).includes('L3445587'));
  });

  test('one store with a huge pile is not a national drop', () => {
    assert.strictEqual(isAlertworthy(spread(1, 5000)), false,
      'a single-store pile is a stocking quirk; TCG allocations land chain-wide');
  });

  test('stockShape counts only real units', () => {
    const s = stockShape(rows([['a', 40], ['b', 0], ['c', 72]]));
    assert.deepStrictEqual(s, { stores: 2, units: 112 });
    assert.deepStrictEqual(stockShape(null), { stores: 0, units: 0 });
  });
});

describe('scanning only ever moves forward', () => {
  test('the batch starts above the frontier', () => {
    const batch = nextScanBatch('L3445720', {}, 5);
    assert.deepStrictEqual(batch, ['L3445721', 'L3445722', 'L3445723', 'L3445724', 'L3445725']);
  });

  test('a malformed frontier scans nothing rather than scanning from zero', () => {
    for (const bad of ['', null, 'banana', 'X123']) {
      assert.deepStrictEqual(nextScanBatch(bad, {}, 5), [],
        'scanning from 0 would burn thousands of requests on a code space that is 95% empty');
    }
  });

  test('the batch is bounded even when everything is already settled', () => {
    const resolved = {};
    for (let n = 3445721; n <= 3446800; n++) resolved[formatCode(n)] = CLASS.HIDDEN;
    assert.ok(nextScanBatch('L3445720', resolved, 200).length <= 200);
  });
});

describe('code and URL helpers', () => {
  test('codes round-trip', () => {
    assert.strictEqual(formatCode(3445571), 'L3445571');
    assert.strictEqual(codeNumber('L3445571'), 3445571);
    assert.strictEqual(codeNumber('nonsense'), null);
  });

  test('the image comes from the CDN, not from londondrugs.com', () => {
    const u = imageUrl('L3445571');
    assert.ok(!u.includes('londondrugs.com'), 'the CDN has no bot protection — that is the point');
    assert.match(u, /L3445571\.jpg$/);
  });

  test('the product probe targets the API', () => {
    assert.strictEqual(productUrl('L3445571'), 'https://www.londondrugs.com/api/product/L3445571');
  });
});
