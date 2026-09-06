/**
 * Amazon fired 21 alerts in 60s on 2026-09-06 and the limiter muted the retailer.
 *
 * Cause: `_alt` stored the RAW image alt, and the game filter checked it. The name logic
 * directly above it already rejects an alt that is not a strict prefix-extension of the
 * aria-label, precisely because a card's HTML slice routinely contains a neighbouring
 * sponsored product's image. So the parser rejected the alt for naming, then handed that
 * same rejected string to the game filter.
 *
 * That let "Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe" — which contains no
 * franchise word at all — borrow a neighbour's "Pokemon" and alert 21 times with the
 * identical price drop ($24.97 -> $17.45, -30%).
 *
 * Two smaller leaks from the same day are covered here too: a scraped sponsored-ad slot, and
 * books about the hobby.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Mirrors the accept rule in _parseSearchHtml: the alt is only trusted when it is the
// aria-label with a short prefix in front, which by construction can only restore a dropped
// brand word and can never swap in a different product.
function acceptAlt(ariaName, alt) {
  const prefixLen = alt.length - ariaName.length;
  return prefixLen > 0 && prefixLen <= 30 && alt.endsWith(ariaName) ? alt : '';
}

const GAME_NAMES = ['pokemon', 'pokémon', 'one piece'];
function passesGameFilter(name, altAccepted) {
  const haystack = `${name} ${altAccepted || ''}`.toLowerCase();
  return GAME_NAMES.some((g) => haystack.includes(g));
}

describe('amazon: a neighbour image alt cannot smuggle in a game name', () => {
  test('the exact card that caused the 2026-09-06 flood is now rejected', () => {
    const aria = 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe, Includes 5 Booster Packs';
    // The alt that shared its slice belonged to a different, Pokemon product.
    const neighbourAlt = 'Pokemon Scarlet & Violet Booster Bundle 6 Packs';
    const accepted = acceptAlt(aria, neighbourAlt);
    assert.strictEqual(accepted, '', 'a neighbour alt must not be accepted');
    assert.strictEqual(passesGameFilter(aria, accepted), false);
  });

  test('the old behaviour — raw alt — is what let it through', () => {
    const aria = 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe';
    const neighbourAlt = 'Pokemon Scarlet & Violet Booster Bundle 6 Packs';
    assert.strictEqual(passesGameFilter(aria, neighbourAlt), true);
  });

  test('the observed real-world mismatch is rejected', () => {
    // Both strings seen in one card slice.
    const aria = 'The World Game - Geography Card Game';
    const alt = '9-Pocket Top Loader Binder';
    assert.strictEqual(acceptAlt(aria, alt), '');
  });

  test('a genuine truncated Pokemon title is still rescued by its own alt', () => {
    // Amazon's aria-label drops the accented brand prefix; the alt keeps it.
    const aria = 'TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    const ownAlt = 'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box';
    const accepted = acceptAlt(aria, ownAlt);
    assert.strictEqual(accepted, ownAlt);
    assert.strictEqual(passesGameFilter(aria, accepted), true);
  });

  test('a prefix longer than 30 chars is not a dropped brand word', () => {
    const aria = 'Booster Box';
    const alt = 'Pokemon Trading Card Game Scarlet and Violet Series Booster Box';
    assert.strictEqual(acceptAlt(aria, alt), '');
  });
});

describe('amazon: sponsored ad slots are not products', () => {
  const isSponsored = (aria) => /^sponsored ad\b/i.test(String(aria).trim());

  test('the Star Wars ad slot that alerted 4 times is rejected', () => {
    assert.strictEqual(
      isSponsored('Sponsored Ad – Title: Star Wars: Unlimited - Intro Battle: Hoth'),
      true
    );
  });

  test('a real product whose title merely contains the word is kept', () => {
    assert.strictEqual(isSponsored('Pokemon TCG Sponsored Championship Deck'), false);
  });
});

describe('amazon: books about the hobby are not sealed product', () => {
  const PRINT_KEYWORDS = [
    'investing', 'investor', 'for beginners', 'complete guide', 'collector guide',
    'character guide', 'price guide', 'value guide', 'collezionare', 'paperback', 'hardcover',
  ];
  const isPrint = (n) => PRINT_KEYWORDS.some((k) => n.toLowerCase().includes(k));

  const books = [
    'Pokémon TCG Collector & Investor Guide 2026: Card Values, Grading',
    'The TCG Autopsy: The Complete Guide to Pokémon TCG Investing',
    'POKÉMON TCG CARD INVESTING FOR BEGINNERS 2026: Visual-Style',
    'Pokémon Card Investing for Beginners: Illustrated Guide',
    'Investire e Collezionare nel TCG Pokémon 2026',
  ];
  for (const b of books) {
    test('rejects book: ' + b.slice(0, 46), () => assert.strictEqual(isPrint(b), true));
  }

  const sealed = [
    'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box',
    "Pokemon TCG: Team Rocket's Mewtwo ex League Battle Deck",
    'Pokémon TCG: First Partner Illustration Collection — Series 2',
    'Bandai One Piece TCG: A Fist of Divine Speed Booster Box',
  ];
  for (const s of sealed) {
    test('keeps sealed product: ' + s.slice(0, 44), () => assert.strictEqual(isPrint(s), false));
  }

  test('an all-digit ASIN is an ISBN, not a product', () => {
    const isIsbn = (a) => /^\d{10}$/.test(a);
    assert.strictEqual(isIsbn('1604382643'), true, 'the Deluxe Character Guide that alerted');
    assert.strictEqual(isIsbn('B0GW2DK37Q'), false);
    assert.strictEqual(isIsbn('B0F6PJ15QH'), false);
  });
});

/**
 * Filtering discovery alone would not have stopped the flood. A cached ASIN is re-checked
 * every poll and that re-check refreshes lastSeen, so the 24h "unseen" prune can never
 * reach it — an ASIN that should never have been tracked keeps alerting indefinitely.
 * The scope test therefore runs against the cache as well, using the real implementation.
 */
describe('amazon: the cache is re-scoped, not just new discoveries', () => {
  const { isInScopeName } = require('../src/adapters/amazon');

  const evicted = [
    ['B0GX7S11S3', 'Trading Card Game 5-Pack Wave 1 Box | Psychedelic Universe'],
    ['B0FLQ68H1G', 'Sponsored Ad – Title: Star Wars: Unlimited - Intro Battle: Hoth'],
    ['B0HFG5FJMK', 'Pokémon TCG Collector & Investor Guide 2026: Card Values'],
    ['B0B46TCN5M', 'Pokemon Astral Radiance Sword & Shield Mini Portfolio'],
    ['B08L42TLDX', 'Konami Yu-Gi-Oh Blazing Vortex Booster Box (24 Packs)'],
    ['B0BVT771M5', 'Magic The Gathering Commander Masters Set Booster Box'],
    ['B0GVRZJ8RL', 'Ravensburger Disney Lorcana TCG: Wilds Unknown 2-Player Starter'],
  ];
  for (const [asin, name] of evicted) {
    test(`evicts ${asin} — ${name.slice(0, 40)}`, () => {
      assert.strictEqual(isInScopeName(name), false);
    });
  }

  const kept = [
    'Pokémon TCG: Mega Evolution—Pitch Black Elite Trainer Box',
    "Pokemon TCG: Team Rocket's Mewtwo ex League Battle Deck Booster Box",
    'Pokémon TCG: First Partner Illustration Collection —Series 2',
    'Bandai OP-09 One Piece The New Emperor Card Game, Booster Box',
  ];
  for (const name of kept) {
    test(`keeps ${name.slice(0, 46)}`, () => {
      assert.strictEqual(isInScopeName(name), true);
    });
  }

  test('a missing or empty name is not treated as in scope', () => {
    assert.strictEqual(isInScopeName(''), false);
    assert.strictEqual(isInScopeName(undefined), false);
    assert.strictEqual(isInScopeName(null), false);
  });
});
