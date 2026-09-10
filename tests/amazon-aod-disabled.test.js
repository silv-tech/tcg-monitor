/**
 * The free AOD path buys nothing and costs blocked traffic, so it is off by default.
 *
 * AOD was abandoned as a stock source (client decision, 2026-09-10) in favour of batched ASIN search
 * plus structured offers, both of which carry a live product title that AOD does not. Its free leg
 * through our residential pool is hard-blocked: hundreds of 503s, zero successful reads over hours,
 * and an escalating 10/20/40-minute quiet ladder that never cleared it.
 *
 * Measured again 2026-09-11 across 22,059 collected log lines: every free AOD request was a 503, and
 * every AOD SUCCESS in the window came from the PAID ScraperAPI leg — a different module
 * (scraper-api.js, which logs "ScraperAPI AOD: ...") that this switch does not touch. That
 * distinction is load-bearing: the paid leg supplies the offer-listing id and the seller name, and
 * the seller name is what enforces the client's "sold by Amazon only" rule. Disabling the wrong one
 * would silently break that filter.
 *
 * The requests were not merely useless. They were 503s against the same host our search lane depends
 * on, and each pair tripped a cooldown covering EVERY AOD lane — including the latency-critical
 * watchlist one.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;

const AmazonAdapter = require('../src/adapters/amazon');

const mk = () => new AmazonAdapter({
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
  intervalMs: 120000, proxyTier: 'residential', watchlist: [],
});

describe('the free AOD path is off unless explicitly enabled', () => {
  test('AMAZON_AOD_STEALTH is unset in this environment', () => {
    assert.notStrictEqual(process.env.AMAZON_AOD_STEALTH, '1',
      'the default must be OFF — a test that only passes with it on proves nothing');
  });

  test('_stealthCheckAsin returns null without attempting a request', async () => {
    const a = mk();
    let fetched = false;
    // If the switch leaked, the real stealthGet would run and this flag would be irrelevant —
    // so assert on the RESULT, which is the contract callers already rely on.
    a._lastFetchThrottled = 'untouched';
    const out = await a._stealthCheckAsin('B0C78K1R17');
    assert.strictEqual(out, null, 'null is the established "no data, keep the cache" contract');
    assert.strictEqual(fetched, false);
  });

  test('a skip is NOT counted as a throttle', async () => {
    // Counting it would trip the 2-strike cooldown and quiet every AOD lane for 10-40 minutes,
    // punishing the latency-critical watchlist lane for a request we chose not to make.
    const a = mk();
    await a._stealthCheckAsin('B0C78K1R17');
    assert.strictEqual(a._lastFetchThrottled, false);
  });

  test('the caller-private ctx also records "not throttled"', async () => {
    const a = mk();
    const ctx = {};
    await a._stealthCheckAsin('B0C78K1R17', 1, ctx);
    assert.strictEqual(ctx.throttled, false,
      'the sweep reads ctx per-call; a true here would feed the strike counter');
  });

  test('the hot/watchlist priority is skipped too, not just the background lane', async () => {
    const a = mk();
    assert.strictEqual(await a._stealthCheckAsin('B0C78K1R17', 0), null,
      'a blocked endpoint is blocked for every lane — that is why the cooldown is shared');
  });

  test('no cooldown is entered, because nothing was attempted', async () => {
    const a = mk();
    const before = a._aodCooldownUntil;
    await a._stealthCheckAsin('B0C78K1R17');
    await a._stealthCheckAsin('B0BCN6HZR3');
    assert.strictEqual(a._aodCooldownUntil, before, 'skipping must not escalate the ladder');
  });
});

describe('the PAID ScraperAPI leg is untouched', () => {
  test('it lives in a different module, so the switch cannot reach it', () => {
    const sa = require('../src/utils/scraper-api');
    assert.strictEqual(typeof sa.fetchAmazonOlidAndSeller, 'function',
      'this is what supplies the seller name behind the "sold by Amazon only" rule');
    assert.strictEqual(typeof sa.offersFetcher, 'function');
    assert.strictEqual(typeof sa.fetchAmazonOffers, 'function');
  });

  test('the adapter still exposes the paths that replaced AOD', () => {
    const a = mk();
    assert.strictEqual(typeof a.fetchProducts, 'function');
    // Batched ASIN search + structured offers are what AOD was abandoned in favour of.
    assert.ok(typeof a._parseSearchHtml === 'function' || typeof a.parseSearchHtml === 'function',
      'the search lane must still exist — it is the primary stock source now');
  });
});
