/**
 * A brand-new listing has to be findable before it sells out.
 *
 * Three "30th Celebration" products were listed, alerted by a competitor, and sold out without
 * this monitor ever seeing one (B0H7FDBNSB, B0H77VZBX4, B0H77W4411 — verified 2026-09-09: two
 * now unavailable, the third still buyable at $27.99 and still not in our catalogue).
 *
 * Two separate causes, both fixed:
 *
 * 1. Amazon's default sort is RELEVANCE, and a new listing has no traction so it does not rank.
 *    Measured on the same query the same day: the newest-first sort returned 24 tiles of which
 *    23 appear nowhere in relevance results. Not a marginal gain — a different view.
 * 2. isTCGProduct rejected "Poster Collection" because 'poster ' is an exclusion and the
 *    exclusion is tested before 'poster collection', which is an inclusion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const { isTCGProduct } = require('../src/utils/helpers');

describe('a sealed form beats a generic exclusion word', () => {
  const cases = [
    ['Pokémon TCG: 30th Celebration Poster Collection', true, 'buyable at $27.99 while we ignored it'],
    ['Pokémon TCG: 30th Celebration Tech Sticker Collection', true, 'sold out before we saw it'],
    ['Pokemon TCG Sticker Collection', true, 'a sealed sticker collection is product'],
    ['Pokemon Charizard Wall Poster 24x36', false, 'a wall poster is still merchandise'],
    ['Pokemon Sticker Sheet Pack of 50', false, 'a sticker sheet is still merchandise'],
  ];
  for (const [name, want, why] of cases) {
    test(`${want ? 'keeps' : 'rejects'}: ${name.slice(0, 46)} — ${why}`, () => {
      assert.strictEqual(isTCGProduct(name), want);
    });
  }
});

describe('every poll probes newest-first as well as relevance', () => {
  function adapter() {
    const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon', url: 'https://www.amazon.ca', intervalMs: 6000 });
    a.searchQueries = ['pokemon tcg', 'pokemon tin', 'one piece booster box'];
    a._logSearchRate = () => {}; a._recordSearchResult = () => {}; a.reportFreshness = () => {};
    a._monitorKnownAsins = async () => {};
    a._purgeOutOfScopeState = async () => {};
    a._guessScanDone = true;
    a._lastAodSweepAt = Date.now();
    return a;
  }

  test('exactly one newest-first probe goes out per poll', async () => {
    const a = adapter();
    const seen = [];
    a._freeSearch = async (query, newest) => { seen.push({ query, newest: !!newest }); return []; };
    await a._runDiscovery({});
    assert.strictEqual(seen.filter((s) => s.newest).length, 1,
      'one probe: the only path that sees a listing before it earns relevance ranking');
    assert.ok(seen.filter((s) => !s.newest).length >= 1, 'relevance searches still run');
  });

  test('the newest probe walks the query list on its own cursor', async () => {
    const a = adapter();
    const probed = [];
    a._freeSearch = async (query, newest) => { if (newest) probed.push(query); return []; };
    for (let i = 0; i < 3; i++) await a._runDiscovery({});
    assert.strictEqual(new Set(probed).size, 3,
      `every query must get a newest-first pass — got ${probed.join(',')}`);
  });

  test('the newest sort is expressed in the URL', async () => {
    const a = adapter();
    const urls = [];
    a._searchOnce = async (url) => { urls.push(url); return null; };
    await a._freeSearch('pokemon tcg', true);
    await a._freeSearch('pokemon tcg', false);
    assert.ok(urls.some((u) => u.includes('s=date-desc-rank')), 'newest probe must ask for the newest sort');
    assert.ok(urls.some((u) => !u.includes('s=date-desc-rank')), 'relevance search must not');
  });
});
