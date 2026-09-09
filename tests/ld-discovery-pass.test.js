/**
 * The London Drugs discovery pass, executed for real.
 *
 * `node --check` cannot see a missing import, and an early version of the enrichment pass called
 * `sleep()` without one — a ReferenceError that only appears once the loop body runs. That is the
 * same failure mode that crash-looped production on 2026-09-09, so every method added here is
 * driven end to end rather than smoke-tested.
 *
 * What the pass must get right:
 *   - a transient origin 500 is never recorded as "code never issued" (~1% of probes)
 *   - settled codes are never re-probed, so the cost shrinks instead of repeating
 *   - hidden codes join the inventory watch — that is the entire point of finding them
 *   - a landed hidden code is reported ONCE, to the admin queue, never to the client channel
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const scraperApi = require('../src/utils/scraper-api');
const state = require('../src/core/state');
const discovery = require('../src/utils/ld-discovery');
const LondonDrugsAdapter = require('../src/adapters/londondrugs');

const CFG = {
  id: 'londondrugs', name: 'London Drugs', url: 'https://www.londondrugs.com',
  adapter: 'londondrugs', intervalMs: 30000, proxyTier: 'residential', enabled: true, timing: {},
};

const HIDDEN = (c) => `{"isSuccess":false,"errors":[{"status":404,"message":"Item not found: ${c} product code ${c} is hidden"}]}`;
const MISSING = (c) => `{"isSuccess":false,"errors":[{"status":404,"message":"Item not found: ${c} product code ${c} not found"}]}`;
const VISIBLE = (c) => JSON.stringify({ isSuccess: true, errors: [], data: { productCode: c, product: { productName: 'Something Published' } } });
const inv = (rows) => JSON.stringify({ isSuccess: true, errors: [], data: rows });

/** An in-memory stand-in for the bits of Redis these paths touch. */
function fakeRedis() {
  const kv = new Map();
  const lists = new Map();
  return {
    kv, lists,
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async set(k, v) { kv.set(k, v); },
    async rpush(k, v) { if (!lists.has(k)) lists.set(k, []); lists.get(k).push(v); },
  };
}

let redis;
let requested;
let BATCH = 5;
beforeEach(() => {
  redis = fakeRedis();
  requested = [];
  BATCH = 5;
  state.getRedis = () => redis;
  scraperApi.isConfigured = () => true;
});

function adapterWith(responder) {
  scraperApi.scraperFetch = async (url) => { requested.push(url); return responder(url); };
  const a = new LondonDrugsAdapter(CFG);
  a._discoveryAt = 0;
  a._storesAt = 0;
  a.discoveryBatch = BATCH;
  return a;
}

async function settle(a, flag) {
  for (let i = 0; i < 400 && a[flag]; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(!a[flag], `${flag} never cleared`);
}

const codeIn = (url) => (url.match(/\/api\/product\/(L\d+)/) || [])[1];

describe('the discovery pass classifies and remembers', () => {
  test('hidden codes are found and kept for monitoring', async () => {
    BATCH = 5;
    const a = adapterWith((url) => {
      const c = codeIn(url);
      return c === 'L3445545' ? HIDDEN(c) : MISSING(c);
    });
    a.discoveryIntervalMs = 0;
    a._maybeDiscover();
    await settle(a, '_discoveryRunning');

    assert.ok(a.hiddenCodes().includes('L3445545'), 'a hidden code is the whole point of the scan');
    const saved = JSON.parse(redis.kv.get('tcg:discovery:londondrugs'));
    assert.strictEqual(saved.resolved.L3445545, discovery.CLASS.HIDDEN);
  });

  test('a transient failure is NOT recorded as a settled answer', async () => {
    BATCH = 3;
    const a = adapterWith(() => { throw new Error('HTTP 500'); });
    a.discoveryIntervalMs = 0;
    a._maybeDiscover();
    await settle(a, '_discoveryRunning');

    const saved = JSON.parse(redis.kv.get('tcg:discovery:londondrugs') || '{"resolved":{}}');
    assert.strictEqual(Object.keys(saved.resolved).length, 0,
      'recording a 500 as "never issued" would permanently skip a real product');
  });

  test('settled codes are not probed again on the next pass', async () => {
    BATCH = 4;
    const a = adapterWith((url) => MISSING(codeIn(url)));
    a.discoveryIntervalMs = 0;
    a._maybeDiscover();
    await settle(a, '_discoveryRunning');
    const first = [...requested];

    requested = [];
    a._discoveryAt = 0;
    a._maybeDiscover();
    await settle(a, '_discoveryRunning');

    const overlap = first.filter((u) => requested.includes(u));
    assert.strictEqual(overlap.length, 0, 're-probing settled codes makes discovery cost constant instead of shrinking');
  });

  test('a visible code is settled without being added to the hidden watch', async () => {
    BATCH = 2;
    const a = adapterWith((url) => VISIBLE(codeIn(url)));
    a.discoveryIntervalMs = 0;
    a._maybeDiscover();
    await settle(a, '_discoveryRunning');
    assert.deepStrictEqual(a.hiddenCodes(), [], 'published product is already found by the category poll');
  });

  test('with no scraper transport it does nothing rather than throwing', () => {
    scraperApi.isConfigured = () => false;
    const a = adapterWith(() => MISSING('L1'));
    a._maybeDiscover();
    assert.strictEqual(requested.length, 0);
    assert.ok(!a._discoveryRunning);
  });
});

describe('hidden codes are watched, and reported once when they land', () => {
  test('a hidden code is looked up by the inventory pass even though it has no product page', async () => {
    const a = adapterWith(() => inv([{ locationCode: '021', stockAvailable: 0 }]));
    a._saveStores = async () => {};
    a._known = new Map();
    a._hidden.add('L3445595');
    a._maybeEnrichStores();
    await settle(a, '_storesRunning');
    assert.strictEqual(requested.length, 1, 'the hidden code must be polled — it is the drop we are waiting for');
    assert.match(requested[0], /L3445595\/inventory/);
  });

  test('a landed hidden code is queued for admin review, exactly once', async () => {
    const rows = Array.from({ length: 46 }, (_, i) => ({ locationCode: String(i).padStart(3, '0'), stockAvailable: 57 }));
    const a = adapterWith(() => inv(rows));
    a._saveStores = async () => {};
    a._known = new Map();
    a._hidden.add('L3445613');

    a._maybeEnrichStores();
    await settle(a, '_storesRunning');
    let queued = redis.lists.get('tcg:ld:candidates') || [];
    assert.strictEqual(queued.length, 1, 'a landed in-store-only drop must be surfaced');
    const c = JSON.parse(queued[0]);
    assert.strictEqual(c.code, 'L3445613');
    assert.strictEqual(c.stores, 46);
    assert.ok(c.image.includes('L3445613.jpg'), 'the box art is how a human identifies an unnamed code');
    assert.ok(!c.image.includes('londondrugs.com'));

    a._storesAt = 0;
    a._maybeEnrichStores();
    await settle(a, '_storesRunning');
    queued = redis.lists.get('tcg:ld:candidates') || [];
    assert.strictEqual(queued.length, 1, 'reporting the same code every 30 minutes would be a flood');
  });

  test('junk stock is screened out — a NETGEAR switch must never be queued', async () => {
    const a = adapterWith(() => inv([{ locationCode: '021', stockAvailable: 1 }]));
    a._saveStores = async () => {};
    a._known = new Map();
    a._hidden.add('L3445566');
    a._maybeEnrichStores();
    await settle(a, '_storesRunning');
    assert.strictEqual((redis.lists.get('tcg:ld:candidates') || []).length, 0,
      '1 unit in 1 store is a stocking quirk, not a national TCG drop');
  });

  test('a hidden code with no stock yet is watched but not reported', async () => {
    const a = adapterWith(() => inv([{ locationCode: '021', stockAvailable: 0 }]));
    a._saveStores = async () => {};
    a._known = new Map();
    a._hidden.add('L3445587');
    a._maybeEnrichStores();
    await settle(a, '_storesRunning');
    assert.strictEqual((redis.lists.get('tcg:ld:candidates') || []).length, 0);
    assert.ok(a.hiddenCodes().includes('L3445587'), 'it stays under watch until the shipment lands');
  });
});
