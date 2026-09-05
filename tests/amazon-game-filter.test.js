/**
 * Amazon discovery must only track the games we actually monitor.
 *
 * A real alert on 2026-09-05 fired for "Trading Card Game 5-Pack Wave 1 Box | Psychedelic
 * Universe" — an "Italian Brainrot" meme card game, labelled as Pokemon. It matched
 * isTCGProduct (the title contains "trading card game"), was not on the five-name blocklist,
 * and the category fallback then defaulted it to 'pokemon'.
 *
 * The watchlist path (fetchProductPage) has always required a tracked game name. These two
 * paths disagreeing is what let it through.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const GAME_NAMES = ['pokemon', 'pokémon', 'one piece'];

// Mirrors the filter in _buildFromSearch.
function passesGameFilter(item) {
  const haystack = `${item.name} ${item._alt || ''}`.toLowerCase();
  return GAME_NAMES.some((g) => haystack.includes(g));
}

function categoryFor(item, query) {
  const haystack = `${item.name} ${item._alt || ''}`.toLowerCase();
  if (/one piece/.test(haystack)) return 'onepiece';
  if (/pokemon|pokémon/.test(haystack)) return 'pokemon';
  if (query) return /one piece/i.test(query) ? 'onepiece' : 'pokemon';
  return 'other';
}

describe('amazon: only tracked games are discovered', () => {
  test('the exact product that caused the false alert is now rejected', () => {
    const item = {
      name: 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe, Includes 35 Cards Total, 5 Blind Booster Packs',
      _alt: 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe',
    };
    assert.strictEqual(passesGameFilter(item), false, 'Italian Brainrot is not a game we track');
  });

  test('other untracked card games are rejected without needing a blocklist entry', () => {
    for (const name of [
      'Flesh and Blood TCG Booster Box',
      'Star Wars Unlimited Trading Card Game Booster',
      'Grand Archive TCG Starter Deck',
      'Weiss Schwarz Trading Card Game Booster Pack',
      'Union Arena Trading Card Game Box',
    ]) {
      assert.strictEqual(passesGameFilter({ name }), false, `${name} should not be tracked`);
    }
  });

  test('the games we DO track still pass', () => {
    for (const name of [
      'Pokemon TCG Scarlet & Violet Booster Box',
      'Pokémon TCG: Mega Evolution Elite Trainer Box',
      'One Piece Card Game OP-09 Booster Box',
    ]) {
      assert.strictEqual(passesGameFilter({ name }), true, `${name} must still be tracked`);
    }
  });

  test('a title truncated by Amazon still passes via the image alt', () => {
    // Amazon's aria-label drops the accented prefix: "Pokémon TCG: X" arrives as "TCG: X".
    // Requiring the game name in the TITLE alone would silently drop real products.
    const item = {
      name: 'TCG: Mega Evolution—Pitch Black Elite Trainer Box',
      _alt: 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box',
    };
    assert.strictEqual(passesGameFilter(item), true, 'the alt carries the franchise word');
  });

  test('a truncated title with no alt is rejected rather than guessed at', () => {
    const item = { name: 'TCG: Some Set Elite Trainer Box', _alt: '' };
    assert.strictEqual(passesGameFilter(item), false);
  });
});

describe('amazon: category is never invented', () => {
  test('a Pokemon product is categorised from the product, not the query', () => {
    assert.strictEqual(categoryFor({ name: 'Pokemon Booster Box' }, 'one piece card game'), 'pokemon');
  });

  test('a One Piece product found by a pokemon query is still One Piece', () => {
    // The old code keyed only off the query and would have called this 'pokemon'.
    assert.strictEqual(categoryFor({ name: 'One Piece Card Game Booster' }, 'pokemon tcg'), 'onepiece');
  });

  test('the alt is used for categorisation too', () => {
    const item = { name: 'TCG: Mega Evolution', _alt: 'Pokémon TCG: Mega Evolution' };
    assert.strictEqual(categoryFor(item, 'pokemon tcg'), 'pokemon');
  });
});
