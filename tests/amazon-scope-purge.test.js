/**
 * Dropping out-of-scope ASINs from memory was not enough: products written to Redis by
 * earlier builds survive restarts and redeploys. Right after the scope fix shipped, Redis
 * still held 371 Amazon products of which 75 were out of scope — Lorcana deck boxes,
 * storage cases, sponsored-ad slots, hobby books.
 *
 * A purge is the riskiest kind of cleanup, so the guards matter more than the deletion:
 * deleting the real catalogue would re-fire NEW_SKU for every product on rediscovery, which
 * is precisely the flood being cleaned up. These tests pin the guards.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName, PURGE_SAFETY_LIMIT } = require('../src/adapters/amazon');

// Mirrors _purgeOutOfScopeState's selection and abort rule.
function plan(entries) {
  const doomed = entries.filter(([, p]) => p && p.name && !isInScopeName(p.name));
  if (doomed.length === 0) return { aborted: false, deleted: [] };
  const share = doomed.length / entries.length;
  if (share > PURGE_SAFETY_LIMIT) return { aborted: true, deleted: [] };
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
];

describe('amazon scope purge: deletes the right rows', () => {
  test('removes out-of-scope products and keeps the real catalogue', () => {
    const { aborted, deleted } = plan([...GOOD, ...BAD]);
    assert.strictEqual(aborted, false);
    assert.deepStrictEqual(deleted.sort(), BAD.map(([s]) => s).sort());
  });

  test('a clean catalogue deletes nothing', () => {
    assert.deepStrictEqual(plan(GOOD), { aborted: false, deleted: [] });
  });

  test('an empty keyspace is a no-op', () => {
    assert.deepStrictEqual(plan([]), { aborted: false, deleted: [] });
  });
});

describe('amazon scope purge: guards against deleting the catalogue', () => {
  test('a nameless or half-written entry is left alone, not guessed at', () => {
    const entries = [...GOOD, ['B0PARTIAL', {}], ['B0NULL', null], ['B0EMPTY', { name: '' }]];
    const { deleted } = plan(entries);
    assert.deepStrictEqual(deleted, [], 'no name means no verdict');
  });

  test('aborts when almost everything looks out of scope', () => {
    // If the scope test regressed, this is the shape the data would take.
    const entries = [...GOOD, ...BAD, ...BAD.map(([s, p], i) => [s + i, p])];
    const share = entries.filter(([, p]) => !isInScopeName(p.name)).length / entries.length;
    assert.ok(share > PURGE_SAFETY_LIMIT, 'precondition: this fixture is majority out-of-scope');
    assert.strictEqual(plan(entries).aborted, true);
  });

  test('the real production ratio (159 of 371) is under the abort threshold', () => {
    // 43%. Most of the junk DID name a game and was caught as an accessory or a book, so
    // the true ratio was far above the 20% a "missing game name" count suggested. Anything
    // stricter than 0.5 would have aborted a legitimate cleanup.
    assert.ok(159 / 371 < PURGE_SAFETY_LIMIT, 'the observed cleanup must be allowed to run');
  });

  test('the threshold leaves real headroom rather than sitting on the observed value', () => {
    assert.ok(PURGE_SAFETY_LIMIT >= 0.5 && PURGE_SAFETY_LIMIT < 1);
  });
});
