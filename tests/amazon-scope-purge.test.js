/**
 * Dropping out-of-scope products from memory was not enough: rows written to Redis by
 * earlier builds survive restarts and redeploys, and a row that is re-checked every poll has
 * its lastSeen refreshed, so an "unseen for 24h" prune can never reach it.
 *
 * Amazon carried 159 such rows out of 371. Walmart, which had no scope test at all, carried
 * 190 out of 360 and alerted on 49 of them.
 *
 * A purge is the riskiest cleanup in the system, so the guards matter more than the deletion:
 * wrongly deleting a catalogue would re-fire NEW_SKU for every product on rediscovery, which
 * is exactly the flood being cleaned up. These tests pin the guards.
 *
 * The abort rule protects against a total regression of the scope test, NOT against a large
 * cleanup — a filter applied for the first time to a catalogue that never had one legitimately
 * removes a lot, and Walmart's genuine share is 53%. An earlier 50% ceiling would have refused
 * that real cleanup, so the rule is now "nearly everything fails, or too little is left".
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName } = require('../src/utils/scope');

// Mirrors BaseAdapter#_purgeOutOfScopeState.
function plan(entries, opts = {}) {
  const { maxShare = 0.9, minKept = 25 } = opts;
  const doomed = entries.filter(([, p]) => p && p.name && !isInScopeName(p.name));
  if (doomed.length === 0) return { aborted: false, deleted: [] };
  const kept = entries.length - doomed.length;
  const share = doomed.length / entries.length;
  if (share > maxShare || kept < minKept) return { aborted: true, deleted: [] };
  return { aborted: false, deleted: doomed.map(([sku]) => sku) };
}

const GOOD = [
  ['B0F6PJ15QH', { name: 'Pokemon TCG Scarlet & Violet 10.5 White Flare Booster Bundle' }],
  ['B0GW2DK37Q', { name: 'Pokémon TCG: First Partner Illustration Collection —Series 2' }],
  ['B0F85QYZJ6', { name: 'Bandai One Piece TCG: A Fist of Divine Speed Booster Box' }],
  ['B0FH118DHT', { name: 'Pokémon TCG: Team Rocket Tin' }],
];
const BAD = [
  ['B0GX7S11S3', { name: 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe' }],
  ['B0FLQ68H1G', { name: 'Sponsored Ad – Title: Star Wars: Unlimited - Intro Battle' }],
  ['B0CSZ5WF3J', { name: 'Ravensburger Disney Lorcana TCG Deck Box' }],
  ['B0HFG5FJMK', { name: 'Pokémon TCG Collector & Investor Guide 2026' }],
  ['10043311', { name: 'UNO Card Game' }],
  ['10073178', { name: 'Phase 10 Card Game' }],
];
// A catalogue big enough to clear minKept, so the selection rule can be tested on its own.
const bulk = (n) => Array.from({ length: n }, (_, i) =>
  ['OK' + i, { name: 'Pokemon TCG: Booster Bundle ' + i }]);

describe('scope purge: deletes the right rows', () => {
  test('removes out-of-scope rows and keeps the real catalogue', () => {
    const { aborted, deleted } = plan([...bulk(30), ...GOOD, ...BAD]);
    assert.strictEqual(aborted, false);
    assert.deepStrictEqual(deleted.sort(), BAD.map(([s]) => s).sort());
  });

  test('a clean catalogue deletes nothing', () => {
    assert.deepStrictEqual(plan([...bulk(30), ...GOOD]), { aborted: false, deleted: [] });
  });

  test('an empty keyspace is a no-op', () => {
    assert.deepStrictEqual(plan([]), { aborted: false, deleted: [] });
  });

  test('Walmart-shaped junk and Amazon-shaped junk are both removed', () => {
    const { deleted } = plan([...bulk(30), ['10043311', { name: 'UNO Card Game' }],
      ['B0GX7S11S3', { name: 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe' }]]);
    assert.deepStrictEqual(deleted.sort(), ['10043311', 'B0GX7S11S3']);
  });
});

describe('scope purge: guards against deleting a catalogue', () => {
  test('a nameless or half-written row is left alone, not guessed at', () => {
    const entries = [...bulk(30), ['PARTIAL', {}], ['NULL', null], ['EMPTY', { name: '' }]];
    assert.deepStrictEqual(plan(entries).deleted, [], 'no name means no verdict');
  });

  test('aborts when nearly everything fails — the scope test regressed', () => {
    const entries = [...bulk(2), ...Array.from({ length: 40 }, (_, i) => ['J' + i, { name: 'UNO Card Game' }])];
    assert.strictEqual(plan(entries).aborted, true);
  });

  test('aborts when too little would be left standing', () => {
    // Only 4 real products survive: plausible as a regression, not a cleanup.
    assert.strictEqual(plan([...GOOD, ...BAD]).aborted, true);
  });

  test("Amazon's real ratio (159 of 371) is allowed", () => {
    const entries = [
      ...Array.from({ length: 212 }, (_, i) => ['OK' + i, { name: 'Pokemon TCG Booster ' + i }]),
      ...Array.from({ length: 159 }, (_, i) => ['NO' + i, { name: 'UNO Card Game ' + i }]),
    ];
    const r = plan(entries);
    assert.strictEqual(r.aborted, false);
    assert.strictEqual(r.deleted.length, 159);
  });

  test("Walmart's real ratio (190 of 360) is allowed — a 50% ceiling would have refused it", () => {
    const entries = [
      ...Array.from({ length: 170 }, (_, i) => ['OK' + i, { name: 'Pokemon TCG Booster ' + i }]),
      ...Array.from({ length: 190 }, (_, i) => ['NO' + i, { name: 'UNO Card Game ' + i }]),
    ];
    const r = plan(entries);
    assert.ok(190 / 360 > 0.5, 'precondition: this is what the old ceiling would have blocked');
    assert.strictEqual(r.aborted, false);
    assert.strictEqual(r.deleted.length, 190);
  });
});
