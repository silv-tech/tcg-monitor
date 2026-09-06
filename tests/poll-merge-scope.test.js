/**
 * Why the partial-poll merge had to learn the scope rule.
 *
 * A partial poll reads only part of a catalogue, so poll-adapter overlays the cached products
 * to keep the rest from looking like it vanished. Every entry in that merged set is then
 * rewritten to Redis with a fresh 7-day TTL.
 *
 * That combination made stale out-of-scope rows immortal. After the shops were scoped, their
 * ~77,000 singles and other-game products were still read from cache, merged forward and
 * rewritten on every fast poll — the TTL reset each time, so nothing could ever expire them.
 * "It will age out on its own" was wrong, and this is the correction.
 *
 * Dropping them from the merge means they simply stop being written and expire normally,
 * with no mass delete. The two guards that make that safe are pinned here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName } = require('../src/utils/scope');

// Mirrors the merge in poll-adapter.js.
function mergePartial(oldProducts, newProducts) {
  const carried = {};
  for (const [sku, cached] of Object.entries(oldProducts)) {
    if (cached && cached.name && !cached._watchlist && !isInScopeName(cached.name)) continue;
    carried[sku] = cached;
  }
  return { ...carried, ...newProducts };
}

const SEALED = { name: 'Pokemon - Blue Sky Stream - Japanese Booster Box', inStock: true };
const SINGLE = { name: 'EEVEE ex (174) - POKEMON SVP EN-SV BLACK STAR PROMO', inStock: true };
const OTHER = { name: 'Disney Lorcana: Attack of the Vine - Collection Starter Set', inStock: true };
const JUNK = { name: 'LEGO 30717 - CREATOR - Fun Halloween Skeleton', inStock: true };

describe('partial merge: out-of-scope rows are not carried forward', () => {
  test('a cached single is dropped instead of being rewritten', () => {
    const merged = mergePartial({ a: SEALED, b: SINGLE }, {});
    assert.deepStrictEqual(Object.keys(merged), ['a']);
  });

  test('other games and non-TCG stock are dropped too', () => {
    const merged = mergePartial({ a: SEALED, b: OTHER, c: JUNK }, {});
    assert.deepStrictEqual(Object.keys(merged), ['a']);
  });

  test('in-scope cached product is still carried, which is the whole point of the merge', () => {
    const merged = mergePartial({ a: SEALED }, { b: { name: 'Pokemon TCG Booster Bundle' } });
    assert.deepStrictEqual(Object.keys(merged).sort(), ['a', 'b']);
  });

  test('the fresh poll always wins over the cached copy', () => {
    const merged = mergePartial({ a: { ...SEALED, inStock: false } }, { a: { ...SEALED, inStock: true } });
    assert.strictEqual(merged.a.inStock, true);
  });
});

describe('partial merge: the guards that make dropping safe', () => {
  test('a row with no name is carried, not guessed at', () => {
    const merged = mergePartial({ a: SEALED, b: {}, c: { name: '' } }, {});
    assert.deepStrictEqual(Object.keys(merged).sort(), ['a', 'b', 'c']);
  });

  test('a watchlist row is carried whatever its title looks like', () => {
    const watched = { name: 'Elite Trainer Box', _watchlist: true };
    assert.strictEqual(isInScopeName(watched.name), false, 'precondition: the name alone fails');
    assert.ok('w' in mergePartial({ w: watched }, {}));
  });

  test('nothing is deleted here — dropped rows are only left unwritten', () => {
    // The merge decides what gets REWRITTEN. Redis deletion is never involved, so a
    // mistake costs one expiry cycle rather than a catalogue.
    const oldProducts = { a: SEALED, b: SINGLE };
    const merged = mergePartial(oldProducts, {});
    assert.ok('b' in oldProducts, 'the source object is untouched');
    assert.ok(!('b' in merged));
  });
});
