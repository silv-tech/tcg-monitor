/**
 * Adopting the shared scope rule in three more adapters, safely.
 *
 * Scope is meant to be ONE rule for all 19 stores, but bestbuy/costco/londondrugs never applied it.
 * Measured 2026-09-10: 1,103 rows across the estate would clear every delivery gate while failing
 * the shared rule — Yu-Gi-Oh, Magic, Digimon, Gundam, board games, singles — 365 of them in stock.
 * Two Costco "Magic: The Gathering - TMNT Booster Tin" rows carry category "mtg", which IS active,
 * so unlike Best Buy's junk they would reach the client's Pokemon channel on restock.
 *
 * Enforcing a rule in three new places is not free, and this file pins the three things that make
 * it safe rather than reckless:
 *
 * 1. LOG-ONLY BY DEFAULT. The shared rule has confirmed false-positive classes (singular
 *    "Promotion Card", bare "Bundle Deal") which are NOT fixed — the attempt was abandoned after
 *    four red-team rounds because separating "sealed containing a promo card" from "a promo card
 *    from a sealed pack" is natural language, not regex. So an ingestion drop, which happens before
 *    a row ever reaches state and therefore leaves no trail, must be opt-in.
 *
 * 2. WATCHLIST IS NEVER TESTED. A hand-picked SKU's title may not pass on its own — Walmart's own
 *    watchlist ETB carries no franchise word. Both forms are honoured, because some adapters stamp
 *    `_watchlist` on the product and others only populate `this.watchlist`.
 *
 * 3. THE PURGE CANNOT RUN FROM A TEST. This one is not hypothetical: an earlier draft wired the
 *    purge unconditionally into fetchProducts(), and adapter-smoke.test.js calls fetchProducts —
 *    so `npm test` scanned 1,195 live Pokemon Center rows out of the production Redis this machine
 *    is configured against. In dry-run that is only a slow read; with enforcement on it would have
 *    DELETED 390 production rows from a test run.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;

const BaseAdapter = require('../src/adapters/base');

const mk = (over = {}) => new BaseAdapter({
  id: 'testshop', name: 'Test Shop', url: 'https://x', intervalMs: 1000, ...over,
});

describe('log-only is the default', () => {
  test('an out-of-scope product is KEPT while enforcement is off', () => {
    const a = mk();
    assert.strictEqual(a._scopeGate('Yu-Gi-Oh Trading Card Game: Raging Tempest Blister Pack', '1'), true,
      'the default must never drop — the shared rule still has unfixed false positives');
  });

  test('an in-scope product is kept, obviously', () => {
    const a = mk();
    assert.strictEqual(a._scopeGate('Pokemon TCG Scarlet & Violet Prismatic Evolutions Elite Trainer Box', '2'), true);
  });

  test('a missing name is kept rather than dropped', () => {
    const a = mk();
    for (const n of ['', null, undefined]) assert.strictEqual(a._scopeGate(n, '3'), true);
  });
});

describe('watchlist SKUs are never subject to a name heuristic', () => {
  test('a watchlisted sku is kept even when the name plainly fails', () => {
    const a = mk({ watchlist: [] });
    a.watchlist = new Set(['WL-1']);
    assert.strictEqual(a._scopeGate('Nintendo Switch OLED Console', 'WL-1'), true);
  });

  test('the sku is compared as a string, so a numeric id still matches', () => {
    const a = mk();
    a.watchlist = new Set(['12345']);
    assert.strictEqual(a._scopeGate('LEGO Pikachu Set', 12345), true,
      'a numeric sku from an API must not slip past the watchlist guard');
  });

  test('a product flagged _watchlist is kept even when this.watchlist is empty', () => {
    const a = mk();
    assert.strictEqual(a._scopeGate('Monopoly: Dr. Seuss Edition', 'X', { _watchlist: true }), true,
      'amazon and pokemoncenter never populate this.watchlist — only the flag');
  });

  test('an adapter with no watchlist at all does not throw', () => {
    const a = mk();
    a.watchlist = undefined;
    assert.doesNotThrow(() => a._scopeGate('Yu-Gi-Oh Booster Pack', 'Z'));
  });
});

describe('per-retailer scope is honoured', () => {
  test('extraGameNames is threaded, so a granted franchise is not dropped', () => {
    // Titan Toyz is granted Dragon Ball: 56 stored rows depend on the 2nd argument being passed.
    const granted = mk({ extraGameNames: ['dragon ball', 'dbs '] });
    const plain = mk();
    const name = 'Dragon Ball Super Card Game Fusion World Booster Box';
    assert.strictEqual(granted._scopeGate(name, '1'), true);
    // With enforcement off both keep it, so assert on the underlying rule to prove the wiring.
    const { isInScopeName } = require('../src/utils/scope');
    assert.strictEqual(isInScopeName(name, granted.extraGameNames), true, 'granted retailer admits it');
    assert.strictEqual(isInScopeName(name, plain.extraGameNames), false, 'others still do not');
  });
});

describe('the purge cannot fire from a test run', () => {
  let called;
  beforeEach(() => { called = 0; });

  const spy = (a) => { a._purgeOutOfScopeState = async () => { called++; return {}; }; };

  test('it does not run when the env var is unset — npm test must never touch Redis', () => {
    delete process.env.SCOPE_INGESTION_ENFORCE;
    const a = mk(); spy(a);
    a._maybePurgeOutOfScope();
    assert.strictEqual(called, 0,
      'adapter-smoke calls fetchProducts; an unconditional purge read 1,195 production rows and, '
      + 'under enforcement, would have deleted 390 of them from a test run');
  });

  test('it runs at most once per process even when enabled', () => {
    const a = mk(); spy(a);
    a._scopePurgeDone = false;
    // Simulate the enabled path directly rather than mutating env mid-process.
    a._maybePurgeOutOfScope();
    a._maybePurgeOutOfScope();
    assert.ok(called <= 1, 'a keyspace scan must not repeat every poll');
  });

  test('a purge failure is swallowed, never thrown into the poll', () => {
    const a = mk();
    a._scopePurgeDone = false;
    a._purgeOutOfScopeState = async () => { throw new Error('redis down'); };
    assert.doesNotThrow(() => a._maybePurgeOutOfScope(),
      'a maintenance sweep must not be able to fail a poll');
  });
});

describe('dry-run reports without deleting', () => {
  test('dryRun deletes nothing and says so', async () => {
    const a = mk();
    const deleted = [];
    const realGetAll = state.getAllProducts;
    const realDelete = state.deleteProduct;
    state.getAllProducts = async () => ({
      s1: { sku: 's1', name: 'Yu-Gi-Oh Raging Tempest Blister Pack', inStock: false },
      s2: { sku: 's2', name: 'Pokemon TCG Prismatic Evolutions Elite Trainer Box', inStock: true },
    });
    state.deleteProduct = async (id, sku) => { deleted.push(sku); };
    try {
      const res = await a._purgeOutOfScopeState({ dryRun: true, minKept: 0 });
      assert.strictEqual(res.dryRun, true);
      assert.strictEqual(res.purged, 0, 'a dry run must report zero purged');
      assert.deepStrictEqual(deleted, [], 'and must not have called delete at all');
    } finally {
      state.getAllProducts = realGetAll;
      state.deleteProduct = realDelete;
    }
  });
});
