/**
 * The partial-poll carry-forward must judge scope the same way the adapter admitted the row.
 *
 * A partial poll reads only part of a catalogue, so poll-adapter overlays the cached products to
 * stop everything it did not read from looking delisted. That overlay filters out rows the scope
 * rule now rejects — correctly, so stale out-of-scope rows stop being rewritten with a fresh TTL.
 *
 * But it called `isInScopeName(cached.name)` with no `extraGameNames`, while every path that ADMITS
 * a row passes it:
 *
 *     shopify.js:1195   isInScopeName(item.title, this.extraGameNames)   -> admitted
 *     base.js:345,383   isInScopeName(name, this.extraGameNames)         -> admitted
 *     poll-adapter:112  isInScopeName(cached.name)                       -> DROPPED
 *
 * Titan Toyz is the only retailer with extraGameNames (["dragon ball", "dbs "]), so it was the only
 * store where the two disagreed — and the disagreement covered every row it exists to track.
 *
 * Measured on the live store 2026-09-11: of 515 stored rows, exactly 73 pass only WITH
 * extraGameNames and 0 fail both ways. Those 73 were torn out of the carry-forward on every 8s
 * poll, so stale cleanup called them delisted and wrote inStock:false; the streak then
 * re-incremented forever, which is why the log read "68 confirmed OOS, 0 awaiting a second poll"
 * on every poll. When a keyword-search tick returned one still genuinely in stock, events.js fired
 * a RESTOCK on stored-false -> reported-true.
 *
 * The arithmetic closed exactly: 73 rows, 5 of them on page 1 every poll -> 68 stale (logged), and
 * on the poll carrying the Dragon Ball search term 10 more returned -> 58 stale (also logged).
 * Absence, not stock — the same shape as the EB Games flood, reached by a different route.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isInScopeName } = require('../src/utils/scope');

const TITAN_EXTRA = ['dragon ball', 'dbs '];

// Real stored titles from the live store.
const DRAGON_BALL = [
  'Dragon Ball Super Card Game Fusion World Manga Booster 02',
  'Dragon Ball Super Battle Card Master Thirty-Third Booster',
  'Dragon Ball Super Card Game FW STORY BOOSTER 01 ST01 Japanese',
  'Dragon Ball Super Divers Advance Pack Vol.2',
];
const POKEMON = 'Pokemon TCG Prismatic Evolutions Elite Trainer Box';

/** Mirrors the carry-forward filter in poll-adapter.js. */
const carriedFrom = (rows, extraGameNames) => {
  const carried = {};
  for (const [sku, cached] of Object.entries(rows)) {
    if (cached && cached.name && !cached._watchlist
        && !isInScopeName(cached.name, extraGameNames)) continue;
    carried[sku] = cached;
  }
  return carried;
};

describe('the asymmetry that caused the flood', () => {
  test('a Dragon Ball row is admitted WITH extraGameNames and rejected without', () => {
    for (const name of DRAGON_BALL) {
      assert.strictEqual(isInScopeName(name, TITAN_EXTRA), true, `admitted: ${name}`);
      assert.strictEqual(isInScopeName(name), false,
        `and rejected by the bare rule — this is the disagreement: ${name}`);
    }
  });
});

describe('the carry-forward keeps what the adapter admitted', () => {
  const rows = Object.fromEntries([...DRAGON_BALL, POKEMON].map((name, i) => [`sku${i}`, { name }]));

  test('WITH extraGameNames every row survives the overlay', () => {
    const carried = carriedFrom(rows, TITAN_EXTRA);
    assert.strictEqual(Object.keys(carried).length, 5,
      'a row torn out here is absent from the merged map, which stale cleanup reads as delisted');
  });

  test('WITHOUT it the Dragon Ball rows are dropped — the bug', () => {
    const carried = carriedFrom(rows, undefined);
    assert.deepStrictEqual(Object.keys(carried), ['sku4'], 'only the Pokemon row survives');
  });

  test('a genuinely out-of-scope row is still dropped, extraGameNames or not', () => {
    const junk = { a: { name: 'LEGO 30717 Creator Fun Halloween Skeleton' } };
    assert.deepStrictEqual(Object.keys(carriedFrom(junk, TITAN_EXTRA)), [],
      'the overlay must still stop stale junk being rewritten with a fresh TTL');
  });

  test('a watchlist row is never dropped whatever its name', () => {
    const wl = { a: { name: 'LEGO 30717 Creator Fun Halloween Skeleton', _watchlist: true } };
    assert.deepStrictEqual(Object.keys(carriedFrom(wl, TITAN_EXTRA)), ['a'],
      'a hand-picked SKU is never judged by a name heuristic');
  });

  test('a row with no name is carried rather than guessed at', () => {
    assert.deepStrictEqual(Object.keys(carriedFrom({ a: {}, b: { name: '' } }, TITAN_EXTRA)), ['a', 'b']);
  });
});

describe('retailers without extraGameNames are unaffected', () => {
  test('an ordinary store behaves exactly as before', () => {
    const rows = { a: { name: POKEMON }, b: { name: 'LEGO 30717 Creator Fun Halloween Skeleton' } };
    assert.deepStrictEqual(Object.keys(carriedFrom(rows, [])), ['a']);
    assert.deepStrictEqual(Object.keys(carriedFrom(rows, undefined)), ['a']);
  });
});
