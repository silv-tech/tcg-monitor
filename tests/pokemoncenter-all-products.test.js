/**
 * Pokemon Center tracks ALL products, not just TCG — and cannot flood if the sitemap shape moves.
 *
 * The client asked for every product on pokemoncenter.com/en-ca, not a TCG subset. The sitemap lane
 * already enumerates the whole store, free, from Railway, every 12h:
 *
 *     Early SKU [Pokemon Center]: 34593 product URLs
 *     Early SKU [Pokemon Center]: 2.8s — 0 new URLs, 0 TCG
 *
 * That trailing "0 TCG" is `newUrls.filter(isPokemonCenterTCG)` discarding roughly 7,600 of the
 * 8,415 distinct SKUs. Removing it is safe in exactly one respect that had to be checked first:
 * `diffUrls` seeds the Redis set with ALL URLs, unfiltered (`sadd` runs on every batch regardless
 * of the filter), and applies the TCG filter only AFTER the diff. So the known set is already
 * complete and widening cannot retro-fire on products that already exist.
 *
 * THE FLOOD RISK THAT REMAINS is the sitemap's URL SHAPE changing — a locale path move, a domain
 * change, a trailing-slash change. Every URL would then miss the Redis set and read as new, and
 * with the TCG filter gone that is ~34,600 alerts in one pass instead of a few hundred. The
 * first-run guard does not help: it only fires when the set is EMPTY.
 *
 * So an implausible batch is treated as a re-seed, loudly, rather than as 34,600 discoveries.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const scanner = require('../src/core/sitemap-scanner');

describe('the TCG filter no longer gates Pokemon Center discovery', () => {
  test('a non-TCG Pokemon Center product is reported as a new listing', () => {
    assert.strictEqual(typeof scanner.pcIsTrackable, 'function',
      'the trackability decision must be exported so it can be tested directly');

    const NON_TCG = [
      'https://www.pokemoncenter.com/en-ca/product/701-12345/pikachu-plush-large',
      'https://www.pokemoncenter.com/en-ca/product/342-00099/eevee-mug-ceramic',
      'https://www.pokemoncenter.com/en-ca/product/100-55555/snorlax-tote-bag',
    ];
    for (const url of NON_TCG) {
      assert.strictEqual(scanner.pcIsTrackable(url), true,
        `every Pokemon Center product is in scope now — ${url}`);
    }
  });

  test('TCG products are still reported', () => {
    const TCG = [
      'https://www.pokemoncenter.com/en-ca/product/699-11111/pokemon-tcg-scarlet-violet-elite-trainer-box',
      'https://www.pokemoncenter.com/en-ca/product/699-22222/prismatic-evolutions-booster-bundle',
    ];
    for (const url of TCG) assert.strictEqual(scanner.pcIsTrackable(url), true, url);
  });

  test('a non-product URL is still rejected', () => {
    // The caller already filters on '/product/', but the predicate must not widen past it.
    assert.strictEqual(scanner.pcIsTrackable('https://www.pokemoncenter.com/en-ca/category/plush'),
      false, 'category and content pages are not products');
    assert.strictEqual(scanner.pcIsTrackable(''), false);
    assert.strictEqual(scanner.pcIsTrackable(null), false);
  });
});

describe('an implausible batch of "new" URLs is a re-seed, not a discovery', () => {
  test('the cap is exported and is far below the catalogue size', () => {
    assert.strictEqual(typeof scanner.PC_MAX_NEW_PER_SCAN, 'number');
    assert.ok(scanner.PC_MAX_NEW_PER_SCAN >= 50,
      'must not suppress a genuine restock wave of new listings');
    assert.ok(scanner.PC_MAX_NEW_PER_SCAN <= 2000,
      `a real catalogue is ~8,415 SKUs / ~34,600 URLs; ${scanner.PC_MAX_NEW_PER_SCAN} would let a `
      + 'URL-shape change alert the entire store');
  });

  test('the guard decides on COUNT, not on content', () => {
    assert.strictEqual(typeof scanner.pcIsImplausibleBatch, 'function');
    assert.strictEqual(scanner.pcIsImplausibleBatch(0), false);
    assert.strictEqual(scanner.pcIsImplausibleBatch(scanner.PC_MAX_NEW_PER_SCAN), false,
      'exactly at the cap is still a normal day');
    assert.strictEqual(scanner.pcIsImplausibleBatch(scanner.PC_MAX_NEW_PER_SCAN + 1), true);
    assert.strictEqual(scanner.pcIsImplausibleBatch(34593), true,
      'the whole store reading as new is the locale-change case this exists for');
  });
});
