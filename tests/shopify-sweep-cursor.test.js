/**
 * A shop must not re-explore its whole catalogue after every restart.
 *
 * _saveSweepCursor persisted only pages that yielded product — "a shop with a hundred empty
 * pages should not rewrite a hundred zeroes" — but _selectSweepPages treats an UNKNOWN page as
 * never-read. So every restart made all ~90 barren pages look fresh again, and the five shops
 * with maxProducts=25000 (100 pages: infinitycards, deckoutgaming, doescards, pokejeux,
 * 401games) spent all ten sweep slots on cold, full-payload fetches, permanently. They never
 * converged onto the small productive set that answers 304, and that ten-request burst every
 * 20 minutes is what earns the 429s that were taking those shops stale.
 *
 * Barren pages are now persisted as page -> timestamp and age out after BARREN_RECHECK_MS, so
 * the churn stops without freezing coverage as a shop grows.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');

// In-memory Redis, so save/load is exercised for real without a server.
const store = new Map();
state.getRedis = () => ({
  get: async (k) => (store.has(k) ? store.get(k) : null),
  set: async (k, v) => { store.set(k, v); return 'OK'; },
});

const ShopifyAdapter = require('../src/adapters/shopify');

function shop(id = 'infinitycards') {
  return new ShopifyAdapter({
    id, name: id, url: `https://${id}.ca`, intervalMs: 9000, maxProducts: 25000,
  });
}

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => store.clear());

describe('sweep selection: what counts as worth reading', () => {
  test('a page never read is explored', () => {
    const a = shop();
    const { pages } = a._selectSweepPages(100, 10);
    assert.strictEqual(pages.length, 10, 'a fresh shop explores its budget');
  });

  test('a page known barren and RECENT is not re-read', () => {
    const a = shop();
    const now = Date.now();
    for (let p = 1; p <= 100; p++) a._pageYield.set(String(p), { n: 0, at: now });
    const { pages } = a._selectSweepPages(100, 10);
    // Only the explore cursor remains — nothing else is worth spending a request on.
    assert.ok(pages.length <= 1, `expected no cold re-reads, got ${pages.length}`);
  });

  test('a page barren for longer than the re-check window is eligible again, but rationed', () => {
    const a = shop();
    const stale = Date.now() - (DAY + 60000);
    for (let p = 1; p <= 100; p++) a._pageYield.set(String(p), { n: 0, at: stale });
    const { pages } = a._selectSweepPages(100, 10);
    assert.ok(pages.length > 1, 'coverage must not freeze as a shop grows');
    assert.ok(pages.length <= 3,
      `stale-barren re-checks must be a trickle, not a flood — got ${pages.length}`);
  });

  test('stale barren pages never crowd out pages that hold product', () => {
    const a = shop();
    const ancient = 1000;   // as good as never checked
    for (let p = 1; p <= 100; p++) a._pageYield.set(String(p), { n: 0, at: ancient });
    a._pageYield.set('3', { n: 12, at: ancient });
    a._pageYield.set('7', { n: 5, at: ancient });
    const { pages } = a._selectSweepPages(100, 10);
    assert.ok(pages.includes(3) && pages.includes(7),
      `productive pages must win the budget — got ${pages.join(',')}`);
  });

  test('productive pages are still re-read', () => {
    const a = shop();
    const now = Date.now();
    for (let p = 1; p <= 100; p++) a._pageYield.set(String(p), { n: 0, at: now });
    a._pageYield.set('7', { n: 12, at: now - 1000 });
    const { pages } = a._selectSweepPages(100, 10);
    assert.ok(pages.includes(7), 'a page holding product must keep being checked');
  });
});

describe('sweep cursor survives a restart', () => {
  test('barren pages are remembered, so a restart does not re-explore the catalogue', async () => {
    const before = shop();
    const now = Date.now();
    for (let p = 1; p <= 100; p++) before._pageYield.set(String(p), { n: 0, at: now });
    before._pageYield.set('3', { n: 40, at: now });
    await before._saveSweepCursor();

    // A restart: fresh instance, same Redis.
    const after = shop();
    await after._loadSweepCursor();

    assert.strictEqual(after._pageYield.size, 100, 'every page verdict must survive');
    const { pages } = after._selectSweepPages(100, 10);
    assert.ok(pages.length <= 2,
      `a restart must not schedule cold re-reads — got ${pages.length}: ${pages.join(',')}`);
    assert.ok(pages.includes(3), 'the productive page is still swept');
  });

  test('the barren record stays small — a number per page, not an object', async () => {
    const a = shop();
    const now = Date.now();
    for (let p = 1; p <= 100; p++) a._pageYield.set(String(p), { n: 0, at: now });
    await a._saveSweepCursor();
    const raw = store.get('tcg:sweepcursor:infinitycards');
    const saved = JSON.parse(raw);
    assert.strictEqual(Object.keys(saved.barren).length, 100);
    assert.strictEqual(typeof saved.barren['1'], 'number', 'a timestamp, not a {n,at} object');
    assert.ok(raw.length < 4000, `payload should stay small, was ${raw.length} bytes`);
  });

  test('an old payload with no barren key still loads', async () => {
    store.set('tcg:sweepcursor:infinitycards', JSON.stringify({
      cursor: 4, handles: { 'a-handle': 'sku1' }, yield: { 3: { n: 5, at: Date.now() } },
    }));
    const a = shop();
    await a._loadSweepCursor();
    assert.strictEqual(a._sweepCursor, 4);
    assert.strictEqual(a._pageYield.get('3').n, 5);
    assert.strictEqual(a._handleToSku.get('a-handle'), 'sku1');
  });

  test('a bare-number payload from the oldest builds still loads', async () => {
    store.set('tcg:sweepcursor:infinitycards', '12');
    const a = shop();
    await a._loadSweepCursor();
    assert.strictEqual(a._sweepCursor, 12);
  });
});
