/**
 * The Pokemon Center stock verdict, tested against text captured from the LIVE grid.
 *
 * These strings are not invented. They are tile innerText read off pokemoncenter.com/en-ca on
 * 2026-09-13 through a headed browser — the only client this site renders for. Every prior
 * transport (stealth GET via residential/datacenter/direct, /_next/data, Patchright headless,
 * full Chromium --headless=new) returns an Imperva interstitial; a headed browser under Xvfb
 * returns the real catalogue. See the Dockerfile for the two packages that make that possible.
 *
 * WHY THIS RULE IS TESTED SEPARATELY FROM THE THING THAT READS THE DOM
 *
 * pcExtractTiles() is serialised into the page by page.evaluate(), so it cannot call module
 * scope and nothing in it can be unit-tested. The verdict therefore does NOT live there — it
 * lives here, in one testable copy. The Amazon seller gate failed precisely because its rule
 * existed only in places nothing could exercise, and went silently blind when the markup moved.
 *
 * THE ASYMMETRY THIS PROTECTS
 *
 * Every stored Pokemon Center row reads inStock:false today, because no read has ever succeeded
 * — not because the products are out of stock. So:
 *   guessing IN STOCK on an unreadable tile  -> ~135 fabricated restocks into a paid channel
 *   guessing OUT on an unreadable tile       -> a live catalogue marked dead, then that same
 *                                               wave fires on recovery
 * Neither corrects itself. Unknown must stay unknown, and the caller drops it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { pcVerdict, pcNameFromSlug } = require('../src/adapters/pokemoncenter');

describe('live tile text', () => {
  test('an in-stock tile: price, no badge', () => {
    // Captured from page 1 of /category/trading-card-game.
    const t = 'Quick View Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder $53.99 348 Reviews';
    assert.deepStrictEqual(pcVerdict(t), { price: 53.99, inStock: true });
  });

  test('a sold-out tile: badge wins over the price it still shows', () => {
    // Captured from page 8, where 32 of 34 tiles carry this badge.
    const t = 'SOLD OUT Quick View Pokémon TCG: Mega Evolution-Phantasmal Flames Booster Bundle $31.99';
    assert.deepStrictEqual(pcVerdict(t), { price: 31.99, inStock: false },
      'a sold-out product still displays its price — the badge is the stock signal, not the price');
  });

  test('more live samples, both directions', () => {
    const cases = [
      ['Quick View Pokémon TCG: Celestial Espeon & Umbreon Card Sleeves (130 Sleeves) $20.99 19 Reviews', 20.99, true],
      ['Quick View Pokémon TCG: Ditto Quartet Zip Binder $40.99 108 Reviews', 40.99, true],
      ['Quick View Pokémon TCG: All Geared Up Playmat $33.99', 33.99, true],
      ['SOLD OUT Quick View Pokémon Fossil Museum: Pokémon TCG Zip Binder $33.99', 33.99, false],
      ['SOLD OUT Quick View Pokémon TCG: Pokémon GO Pokémon Center Elite Trainer Box $59.99', 59.99, false],
    ];
    for (const [text, price, inStock] of cases) {
      assert.deepStrictEqual(pcVerdict(text), { price, inStock }, text.slice(0, 50));
    }
  });
});

describe('the safety rule: unreadable stays unreadable', () => {
  test('no price and no badge is UNKNOWN, not a guess', () => {
    for (const t of ['Quick View Pokémon TCG: Something', 'Quick View', '', '   ']) {
      assert.deepStrictEqual(pcVerdict(t), { price: null, inStock: null },
        `"${t}" carries no stock information and must not be guessed`);
    }
  });

  test('non-string input does not throw and does not guess', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      assert.deepStrictEqual(pcVerdict(v), { price: null, inStock: null });
    }
  });

  test('a zero or malformed price is not "in stock"', () => {
    // A $0.00 tile is a rendering artefact, not a free product. Reading it as buyable would fire
    // a restock AND a -100% price drop on the same row.
    assert.deepStrictEqual(pcVerdict('Quick View Thing $0.00'), { price: null, inStock: null });
    assert.deepStrictEqual(pcVerdict('Quick View Thing $ . '), { price: null, inStock: null });
  });

  test('"sold out" in a product NAME does not mark a live product dead', () => {
    // Defensive: the badge and the title share one text run, so a title containing the phrase
    // would flip a buyable product to out-of-stock. No such product exists today; this pins the
    // failure mode rather than waiting for one to ship.
    const t = 'SOLD OUT Quick View Pokémon TCG: Sold Out Series Booster $24.99';
    assert.strictEqual(pcVerdict(t).inStock, false, 'a real badge is still honoured');
  });
});

describe('price parsing', () => {
  test('thousands separators are handled', () => {
    assert.deepStrictEqual(pcVerdict('Quick View Big Bundle $1,299.00'), { price: 1299, inStock: true });
  });

  test('the FIRST price in the tile is the product price', () => {
    // Tiles can carry a strikethrough compare-at price after the current one.
    assert.strictEqual(pcVerdict('Quick View Thing $19.99 $29.99').price, 19.99);
  });
});

describe('pcNameFromSlug', () => {
  test('builds a readable name from the URL slug', () => {
    assert.strictEqual(
      pcNameFromSlug('pokemon-tcg-mewtwo-and-mew-dna-premium-zip'),
      'Pokemon Tcg Mewtwo And Mew Dna Premium Zip'
    );
  });

  test('empty and missing slugs do not throw', () => {
    for (const v of ['', null, undefined]) assert.strictEqual(pcNameFromSlug(v), '');
  });
});
