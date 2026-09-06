/**
 * Costco must track Pokemon and One Piece CARD products — not every card-shaped thing, and
 * not every Pokemon-branded thing.
 *
 * The filter was one list mixing game names with product forms, so either half could match
 * alone. What was actually in the cache on 2026-09-05:
 *
 *   Magic: The Gathering — TMNT Booster Tin Collection   passed via "booster tin"
 *   Upper Deck Golf Trading Card Blaster Box             passed via "trading card"
 *   Pokemon Home Edition Plus Pinball Game ($7,299.99)   franchise, no card form
 *   Pokémon Legends Z-A — Nintendo Switch 2              a video game
 *   LEGO Pokémon Pikachu and Poké Ball                   a LEGO set
 *   Tonies Pokémon Toniebox 2 Starter Set                an audio toy
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const GAMES = ['pokemon', 'pokémon', 'pokmon', 'one piece'];
const FORMS = ['tcg', 'trading card', 'booster box', 'booster pack', 'booster tin',
  'booster bundle', 'elite trainer', 'etb', 'collection box', 'premium collection',
  'ex box', 'ex boxes', 'card game', 'tin', 'blister'];

function isTrackedCardProduct(title) {
  const t = String(title || '').toLowerCase();
  if (!GAMES.some((g) => t.includes(g))) return false;
  return FORMS.some((f) => t.includes(f));
}

describe('costco: wrong GAME is rejected even when it is a card product', () => {
  for (const name of [
    'Magic: The Gathering - TMNT Booster Tin Collection',
    'Magic: The Gathering | Marvel Super Heroes Commander',
    'Upper Deck Golf Trading Card Blaster Box 2-pack',
    'Topps Chrome Baseball Trading Cards Mega Box',
  ]) {
    test(`rejects: ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), false);
    });
  }
});

describe('costco: right game but NOT a card product is rejected', () => {
  for (const name of [
    'Pokemon Home Edition Plus Pinball Game',
    'Pokémon Legends Z-A - Nintendo Switch 2',
    'Pokémon Pokopia - Nintendo Switch 2',
    'LEGO Pokémon Pikachu and Poké Ball 72152',
    'Tonies Pokémon  Toniebox 2 Starter Set Lightning Yellow',
  ]) {
    test(`rejects: ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), false);
    });
  }
});

describe('costco: real card products still pass', () => {
  for (const name of [
    'Pokémon TCG: Mega Charizard X ex Ultra Premium Collection',
    'Pokémon Unova Heavy Hitters Premium Collection',
    'Pokémon TCG: Prismatic Evolutions Super-Premium Collection',
    'Pokémon 2 Pack ex Boxes (Mega Emboar ex & Mega Feraligatr ex)',
    'One Piece Card Game Booster Box OP-09',
  ]) {
    test(`keeps: ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isTrackedCardProduct(name), true);
    });
  }
});

describe('costco: the old filter is what let them through', () => {
  test('a single mixed list cannot express "game AND form"', () => {
    const OLD = [...FORMS, 'pokemon tcg', 'one piece card'];
    const mtg = 'Magic: The Gathering - TMNT Booster Tin Collection'.toLowerCase();
    assert.ok(OLD.some((k) => mtg.includes(k)), 'old filter passed it');
    assert.strictEqual(isTrackedCardProduct(mtg), false, 'new filter blocks it');
  });
});
