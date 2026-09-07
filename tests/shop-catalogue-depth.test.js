/**
 * Catalogue depth config for the Shopify shops.
 *
 * fetchAllProducts falls back to maxProducts = 2,500 when the config omits it, which is ten
 * pages — the exact ceiling that made Hobbiesville invisible past 18% of its catalogue. Eight
 * more shops were sitting on that default. Measured against the live stores, page 11 alone
 * (the first page past the cap) held in-scope sealed product at seven of them:
 *
 *   doescards 45, remicardtrader 41, zardocards 27, gameshack 18, chimeragaming 9,
 *   infinitycards 2, deckoutgaming 1
 *
 * A shop that silently omits this value gets the 2,500 cap back and starts missing alerts with
 * nothing in the logs to show for it, so the value is asserted rather than left to convention.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;

// These use their own adapters and are deliberately out of scope for this change.
const BIG_SEVEN = ['walmart', 'ebgames', 'costco', 'amazon', 'pokemoncenter', 'bestbuy', 'londondrugs'];

describe('every catalogue-wide Shopify shop declares its depth', () => {
  const shops = list.filter((r) => r.adapter === 'shopify' && (r.collections || []).length === 0);

  test('there are shops on the catalogue-wide path', () => {
    assert.ok(shops.length > 0);
  });

  for (const shop of shops) {
    test(`${shop.id} sets maxProducts explicitly`, () => {
      assert.ok(Number(shop.maxProducts) > 0,
        `${shop.id} would silently fall back to the 2,500 cap`);
    });

    test(`${shop.id} is configured deeper than the old cap`, () => {
      assert.ok(Number(shop.maxProducts) > 2500,
        `${shop.id} at ${shop.maxProducts} is no better than the default that hid 84% of Hobbiesville`);
    });
  }
});

describe('the big seven are not affected by this change', () => {
  for (const id of BIG_SEVEN) {
    test(`${id} does not use the shopify adapter`, () => {
      const r = list.find((x) => x.id === id);
      assert.ok(r, `${id} must exist`);
      assert.notStrictEqual(r.adapter, 'shopify',
        'the catalogue-depth change applies only to Shopify shops');
    });
  }
});

describe('a collection-based shop is not required to set depth', () => {
  test('chimeragaming reads a collection, which is a single page', () => {
    const r = list.find((x) => x.id === 'chimeragaming');
    assert.ok((r.collections || []).length > 0,
      'chimeragaming reads a collection, so the catalogue-wide cap does not apply to it');
  });
});

describe('no shop is polled faster than it tolerates', () => {
  // What a shop objects to is the request RATE, not the interval. Hobbiesville and Kanzen
  // Games ran two collections at 8s — 0.25 req/s — and began refusing within minutes:
  // production logged "Cooling down 111s after 429" on their collection URLs and the poll
  // failed outright, returning nothing at all. Chimera Gaming polls at the same 8s and is
  // perfectly healthy, because it reads ONE collection: 0.125 req/s.
  //
  // So the ceiling is expressed as a rate. 0.125 req/s is the highest figure observed running
  // clean, and pinning it here is what stops the interval being optimistically lowered again
  // without accounting for how many requests each poll actually makes.
  const MAX_REQ_PER_SEC = 0.125;
  const shops = list.filter((r) => r.adapter === 'shopify');

  for (const shop of shops) {
    // A collection shop fetches one request per collection and runs no keyword search.
    // A catalogue shop fetches page 1 plus one search term per poll.
    const perPoll = (shop.collections || []).length || 2;
    const rate = perPoll / (shop.intervalMs / 1000);

    test(`${shop.id}: ${perPoll} req / ${shop.intervalMs}ms = ${rate.toFixed(3)} req/s`, () => {
      assert.ok(rate <= MAX_REQ_PER_SEC + 1e-9,
        `${shop.id} at ${rate.toFixed(3)} req/s exceeds the ${MAX_REQ_PER_SEC} req/s that ran clean`);
    });
  }
});
