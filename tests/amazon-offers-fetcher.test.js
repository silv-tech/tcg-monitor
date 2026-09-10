/**
 * The structured/amazon/offers fetcher — the ~1-credit replacement for the ~10-18 credit AOD /
 * product-page fetch. It returns raw offers JSON (the caller applies the pinned-offer stock rule),
 * never throws, and spends a credit ONLY on a real 200. On anything else it returns null, which the
 * verifier reads as "inconclusive" (fail open) and price-fill reads as "leave the tile as-is".
 */

process.env.SCRAPER_API_KEY = 'test-key-offers'; // must be set BEFORE requiring scraper-api

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

// scraper-api touches Redis lazily via state.getRedis() in restore/persistBudget — stub it so the
// test opens no ioredis handle (which would keep the process alive).
const state = require('../src/core/state');
state.getRedis = () => ({ get: async () => null, set: async () => {} });

const scraper = require('../src/utils/scraper-api');

const OFFERS = { item: { name: 'Pokémon TCG: 30th Celebration ETB' }, listings: [{ price: 89.99, pinned_offer: true, seller_name: 'Amazon.ca' }] };
const account = { ok: true, json: async () => ({ requestCount: 100, requestLimit: 100000 }) }; // 0.1% → not paused

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('fetchAmazonOffers', () => {
  test('returns parsed JSON on a 200 and records exactly one credit', async () => {
    global.fetch = async (url) => (String(url).includes('/account') ? account : { ok: true, json: async () => OFFERS });
    const before = scraper.getBudgetStatus().localTotal;
    const data = await scraper.fetchAmazonOffers('B0H78BB9TY');
    assert.deepStrictEqual(data, OFFERS, 'raw offers JSON returned');
    assert.strictEqual(scraper.getBudgetStatus().localTotal, before + 1, 'exactly one credit recorded on success');
  });

  test('hits the structured endpoint with the asin', async () => {
    let captured = '';
    global.fetch = async (url) => { const u = String(url); if (u.includes('/account')) return account; captured = u; return { ok: true, json: async () => OFFERS }; };
    await scraper.fetchAmazonOffers('B0ABC12345');
    assert.ok(captured.includes('/structured/amazon/offers'), `structured endpoint (got ${captured})`);
    assert.ok(captured.includes('asin=B0ABC12345'), 'passes the asin');
  });

  test('MUST pin tld=ca — the silent currency trap (wrong tld = ~35%-low USD prices + no pinned offer)', async () => {
    let captured = '';
    global.fetch = async (url) => { const u = String(url); if (u.includes('/account')) return account; captured = u; return { ok: true, json: async () => OFFERS }; };
    await scraper.fetchAmazonOffers('B0ABC12345');
    assert.ok(captured.includes('tld=ca'), `offers URL must carry tld=ca for CAD prices — got ${captured}`);
    assert.ok(!captured.includes('tld=com'), 'never amazon.com (USD)');
  });

  test('returns null on a non-200 (403 still-blocked / 429 exhausted) and spends NO credit', async () => {
    global.fetch = async (url) => (String(url).includes('/account') ? account : { ok: false, status: 403 });
    const before = scraper.getBudgetStatus().localTotal;
    const data = await scraper.fetchAmazonOffers('B0X');
    assert.strictEqual(data, null);
    assert.strictEqual(scraper.getBudgetStatus().localTotal, before, 'a failed call must not count a credit');
  });

  test('returns null on a thrown/aborted fetch (inconclusive → fail open)', async () => {
    global.fetch = async (url) => { if (String(url).includes('/account')) return account; throw new Error('socket hang up'); };
    assert.strictEqual(await scraper.fetchAmazonOffers('B0X'), null);
  });
});

describe('offersFetcher (verify() injection adapter)', () => {
  test('extracts the asin from a /dp/ url and returns the offers JSON', async () => {
    let captured = '';
    global.fetch = async (url) => { const u = String(url); if (u.includes('/account')) return account; captured = u; return { ok: true, json: async () => OFFERS }; };
    const data = await scraper.offersFetcher('https://www.amazon.ca/dp/B0DEF67890?th=1');
    assert.deepStrictEqual(data, OFFERS);
    assert.ok(captured.includes('asin=B0DEF67890'), 'asin pulled from the /dp/ path');
  });

  test('returns null for a url carrying no asin', async () => {
    assert.strictEqual(await scraper.offersFetcher('https://www.amazon.ca/gp/bestsellers'), null);
  });
});
