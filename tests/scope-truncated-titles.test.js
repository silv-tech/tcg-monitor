/**
 * A near miss worth pinning permanently.
 *
 * After the scope rule was tightened to require isTCGProduct, production still showed one
 * "out of scope" Walmart row: 6000208831664, "Scarlet & Violet—Prismatic Evolutions Elite
 * Trainer Box". That is not junk — it is Walmart's WATCHLIST item, and the product behind the
 * biggest drop this monitor has covered. Walmart's title simply omits the word "Pokemon", so
 * a franchise-word rule rejected it, and the purge would have deleted it.
 *
 * Two independent defences now exist, because either one alone is a single point of failure:
 *   1. a recognised set name counts as naming the game, and
 *   2. a watchlist SKU is never scope-filtered or purged, whatever its title says.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isInScopeName, SET_NAMES } = require('../src/utils/scope');

describe('scope: retailer titles that drop the franchise word', () => {
  const realButUnbranded = [
    ['Scarlet & Violet—Prismatic Evolutions Elite Trainer Box', 'the Walmart watchlist item'],
    ['TCG: Mega Evolution—Pitch Black Elite Trainer Box', "Amazon's truncated aria-label"],
    ['Scarlet & Violet 151 Booster Bundle', 'set name only'],
    ['Prismatic Evolutions Surprise Box', 'set name only'],
    ['Mega Evolution Chaos Rising Booster Bundle', 'set name only'],
    ['Sword & Shield—Evolving Skies Booster Box', 'set name only'],
  ];
  for (const [name, why] of realButUnbranded) {
    test(`keeps ${name.slice(0, 44)} (${why})`, () => {
      assert.strictEqual(isInScopeName(name), true);
    });
  }

  test('none of these contain a franchise word — that is the whole point', () => {
    const GAMES = ['pokemon', 'pokémon', 'one piece'];
    for (const [name] of realButUnbranded) {
      assert.ok(!GAMES.some((g) => name.toLowerCase().includes(g)),
        `${name} must NOT contain a game name, or this test proves nothing`);
    }
  });

  test('set names are evidence, not an exemption — junk named after a set is still dropped', () => {
    assert.strictEqual(isInScopeName('Scarlet & Violet Nintendo Switch Game'), false);
    assert.strictEqual(isInScopeName('Mega Evolution Playmat'), false);
    assert.strictEqual(isInScopeName('Prismatic Evolutions Card Binder 9-Pocket'), false);
  });

  test('the set list is non-trivial and lowercase, so matching is predictable', () => {
    assert.ok(SET_NAMES.length >= 20);
    for (const s of SET_NAMES) assert.strictEqual(s, s.toLowerCase(), s);
  });
});

/**
 * Defence 2, expressed as the rule the adapters implement: a watchlist SKU is exempt.
 * Mirrors the guard in WalmartAdapter#_scopeFilter and BaseAdapter#_purgeOutOfScopeState.
 */
describe('scope: a watchlist SKU is never filtered or purged', () => {
  const watchlist = new Set(['6000208831664']);
  const keep = (sku, product) =>
    product._watchlist || watchlist.has(String(sku)) || isInScopeName(product.name);

  test('the real watchlist row survives even with a title that fails the name test', () => {
    // Deliberately a title the name rule rejects, to prove the exemption does the work.
    assert.strictEqual(keep('6000208831664', { name: 'Elite Trainer Box' }), true);
    assert.strictEqual(isInScopeName('Elite Trainer Box'), false);
  });

  test('the _watchlist flag alone is enough, for rows fetched by the watchlist path', () => {
    assert.strictEqual(keep('999', { name: 'Elite Trainer Box', _watchlist: true }), true);
  });

  test('the exemption is not a blanket bypass — ordinary junk is still dropped', () => {
    assert.strictEqual(keep('10043311', { name: 'UNO Card Game' }), false);
    assert.strictEqual(keep('123', { name: 'Pokémon™ Violet (Nintendo Switch)' }), false);
  });
});
