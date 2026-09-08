/**
 * EB Games: the paid fallback, and the floor that keeps it affordable.
 *
 * Cloudflare began refusing every free route into ebgames.ca. Measured 2026-09-08, all within
 * 200ms and identical: direct 403, ISP exit 403, residential 403. The adapter reported
 * "found 0 products" on every poll for hours while /health still said healthy, because a poll
 * that returns nothing without throwing is not an error — the same blind spot that hid Walmart.
 *
 * ScraperAPI standard returns the real listing for 1 credit (927KB, 27 product links, no
 * challenge), so the store is recoverable but no longer free. Two things therefore matter:
 *
 *   1. The free route must still be tried every poll, so the day Cloudflare relents EB Games
 *      returns to full speed at zero cost without anyone intervening.
 *   2. The paid route must be paced. At the adapter's 5s interval an unpaced fallback is
 *      ~52,000 credits a day — 156% of the monthly budget — so it is gated by a floor, with a
 *      burst window so one poll's pages travel together. Gating per request would deliver one
 *      page per floor and never assemble a complete listing.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const EBGames = require('../src/adapters/ebgames');
const scraperApi = require('../src/utils/scraper-api');

function adapter() {
  const a = new EBGames({
    id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
    intervalMs: 5000, proxyTier: 'none',
  });
  a._throttle = async () => {};
  return a;
}

// isChallenge() treats anything under 2000 bytes as a challenge, so a realistic listing has to
// clear that — a short stub would be rejected before the fallback logic is ever reached.
const PAGE = '<html><body>'
  + '<a href="/shop/trading-cards-pokemon-204/900687-japanese-pokemon-storm-emeralda-booster-215190">x</a>'
  + '<!-- '.padEnd(2400, 'x') + ' -->'
  + '</body></html>';

describe('ebgames paid fallback', () => {
  let calls;
  beforeEach(() => { calls = { stealth: 0, paid: 0 }; });

  function wire(a, { stealthWorks }) {
    a.stealthFetch = async () => { calls.stealth++; if (!stealthWorks) throw new Error('Blocked after 2 stealth attempts: 403'); return PAGE; };
    scraperApi.isConfigured = () => true;
    scraperApi.scraperFetch = async () => { calls.paid++; return PAGE; };
  }

  test('the free route is used when it works, and costs nothing', async () => {
    const a = adapter(); wire(a, { stealthWorks: true });
    await a._fetchListing('https://www.ebgames.ca/shop/category/trading-cards-pokemon-204');
    assert.strictEqual(calls.stealth, 1);
    assert.strictEqual(calls.paid, 0, 'a working free route must never spend a credit');
  });

  test('a blocked free route falls back to the paid one', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    const html = await a._fetchListing('https://www.ebgames.ca/x');
    assert.strictEqual(calls.paid, 1);
    assert.match(html, /trading-cards-pokemon-204/);
  });

  test('the free route is still attempted on every poll, so the block can heal itself', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    for (let i = 0; i < 3; i++) await a._fetchListing('https://www.ebgames.ca/x').catch(() => {});
    assert.strictEqual(calls.stealth, 3,
      'if the free route stopped being tried, EB Games would stay paid forever after one block');
  });

  test('one poll\'s pages travel together in a single burst', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    for (let i = 0; i < 3; i++) await a._fetchListing(`https://www.ebgames.ca/p${i}`);
    assert.strictEqual(calls.paid, 3,
      'gating per request would starve pages 2 and 3 and never assemble a full listing');
  });

  test('a second burst inside the floor is refused', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    await a._fetchListing('https://www.ebgames.ca/a');
    a._paidWindowUntil = 0;             // burst over, floor still running
    // Refused by OUR floor, so it throws a self-skip rather than the retailer's 403. The
    // distinction is what keeps these out of the circuit breaker; see the self-skip suite below.
    const err = await a._fetchListing('https://www.ebgames.ca/b').catch((e) => e);
    assert.strictEqual(err.selfSkip, true,
      'without a floor this is ~52,000 credits a day, over the whole monthly budget');
    assert.strictEqual(calls.paid, 1);
  });

  test('once the floor has passed, a new burst is allowed', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    await a._fetchListing('https://www.ebgames.ca/a');
    a._paidWindowUntil = 0;
    a._lastPaidAt = Date.now() - 60000; // floor elapsed
    await a._fetchListing('https://www.ebgames.ca/b');
    assert.strictEqual(calls.paid, 2);
  });

  test('a paid route that returns nothing surfaces the free route\'s error', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    scraperApi.scraperFetch = async () => { calls.paid++; return null; }; // budget-paused
    await assert.rejects(() => a._fetchListing('https://www.ebgames.ca/x'), /403/,
      'a null from the paid route is not a page — health must see the real failure, not silence');
  });

  test('with no ScraperAPI key it fails like before rather than throwing something new', async () => {
    const a = adapter(); wire(a, { stealthWorks: false });
    scraperApi.isConfigured = () => false;
    await assert.rejects(() => a._fetchListing('https://www.ebgames.ca/x'), /403/);
    assert.strictEqual(calls.paid, 0);
  });
});

/**
 * A time window alone does not bound cost.
 *
 * The first version floored how OFTEN a burst could start and left the burst itself unbounded.
 * Production then billed 56,640 credits a day — 4.4x the estimate, exhausting a 1,000,000
 * budget in under three weeks — because the five-minute deep crawl's ~30 pages all travelled
 * through one open window. The floor was doing exactly what it said and still failed to control
 * spend, which is the useful part: rate limits have two dimensions and only one was capped.
 */
describe('ebgames paid burst is bounded in size, not just frequency', () => {
  function wiredAdapter() {
    const a = new EBGames({ id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
      intervalMs: 5000, proxyTier: 'none' });
    a._throttle = async () => {};
    a.stealthFetch = async () => { throw new Error('Blocked after 2 stealth attempts: 403'); };
    scraperApi.isConfigured = () => true;
    let paid = 0;
    scraperApi.scraperFetch = async () => { paid += 1; return PAGE; };
    return { a, paid: () => paid };
  }

  test('a deep crawl cannot drain the budget through one open window', async () => {
    const { a, paid } = wiredAdapter();
    // 30 pages arriving together, as the deep crawl does.
    for (let i = 0; i < 30; i++) await a._fetchListing(`https://www.ebgames.ca/p${i}`).catch(() => {});
    assert.ok(paid() <= 4,
      `${paid()} paid calls went through one burst — unbounded bursts cost 56,640 credits/day`);
  });

  test('the cap resets on the next burst, so the crawl still completes over time', async () => {
    const { a, paid } = wiredAdapter();
    for (let i = 0; i < 10; i++) await a._fetchListing(`https://www.ebgames.ca/a${i}`).catch(() => {});
    const first = paid();
    a._paidWindowUntil = 0;
    a._lastPaidAt = Date.now() - 120000; // floor elapsed
    for (let i = 0; i < 10; i++) await a._fetchListing(`https://www.ebgames.ca/b${i}`).catch(() => {});
    assert.ok(paid() > first, 'a later burst must be allowed, or the catalogue never refreshes');
    assert.ok(paid() <= 8, 'and it must still be capped');
  });
});

/**
 * The deep crawl needs its own allowance.
 *
 * Capping it at the fast poll's four-call burst pinned coverage at 67 of 801 products: every
 * crawl re-fetched the same first four pages and never reached the rest, so the catalogue sat
 * frozen while the cost graph looked healthy. Fixing spend by starving coverage is not fixing
 * anything — it just moves the failure somewhere with no alarm on it.
 */
describe('ebgames deep crawl allowance', () => {
  test('a crawl can fetch a whole catalogue, well past the fast poll burst cap', async () => {
    const a = new EBGames({ id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
      intervalMs: 5000, proxyTier: 'none' });
    a._throttle = async () => {};
    a.stealthFetch = async () => { throw new Error('Blocked after 2 stealth attempts: 403'); };
    scraperApi.isConfigured = () => true;
    let paid = 0;
    scraperApi.scraperFetch = async () => { paid += 1; return PAGE; };

    a._crawlPaidRemaining = 40;   // as _deepCrawl grants
    for (let i = 0; i < 30; i++) await a._fetchListing(`https://www.ebgames.ca/p${i}`).catch(() => {});
    assert.strictEqual(paid, 30, 'the crawl must be able to walk every page in one pass');
  });

  test('the grant is finite — a runaway crawl still stops', async () => {
    const a = new EBGames({ id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
      intervalMs: 5000, proxyTier: 'none' });
    a._throttle = async () => {};
    a.stealthFetch = async () => { throw new Error('Blocked after 2 stealth attempts: 403'); };
    scraperApi.isConfigured = () => true;
    let paid = 0;
    scraperApi.scraperFetch = async () => { paid += 1; return PAGE; };

    a._crawlPaidRemaining = 5;
    for (let i = 0; i < 50; i++) await a._fetchListing(`https://www.ebgames.ca/p${i}`).catch(() => {});
    assert.ok(paid <= 5 + 4, `spent ${paid} — the grant plus at most one fast-poll burst`);
  });
});

/**
 * A page we declined to buy is not a retailer failure.
 *
 * The fast poll runs every 5s; the paid floor allows a purchase every 30s. So five polls in six
 * legitimately buy nothing — and counting those as poll errors gave EB Games 33 consecutive
 * failures and a degraded health status while it was working correctly and finding 250 products.
 *
 * Worse than the wrong status: enough consecutive errors trip the circuit breaker, and its
 * recovery probes would hit the same floor and fail again. That is the loop that kept the
 * Shopify shops down for hours on 2026-09-05, and the rule learned there — isSelfSkip — is the
 * same one that applies here.
 */
describe('ebgames self-skip is not an error', () => {
  test('a refusal by our own floor is marked as ours', async () => {
    const a = new EBGames({ id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
      intervalMs: 5000, proxyTier: 'none' });
    a._throttle = async () => {};
    a.stealthFetch = async () => { throw new Error('Blocked after 2 stealth attempts: 403'); };
    scraperApi.isConfigured = () => true;
    scraperApi.scraperFetch = async () => PAGE;

    await a._fetchListing('https://www.ebgames.ca/a');   // opens the burst
    a._paidWindowUntil = 0;                              // burst over, floor still running
    const err = await a._fetchListing('https://www.ebgames.ca/b').catch((e) => e);
    assert.strictEqual(err.selfSkip, true,
      'unmarked, this reads as a retailer failure and counts toward the circuit breaker');
  });

  test('a retailer refusal is NOT marked as ours', async () => {
    const a = new EBGames({ id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
      intervalMs: 5000, proxyTier: 'none' });
    a._throttle = async () => {};
    a.stealthFetch = async () => { throw new Error('Blocked after 2 stealth attempts: 403'); };
    scraperApi.isConfigured = () => false;               // no paid route at all
    const err = await a._fetchListing('https://www.ebgames.ca/x').catch((e) => e);
    assert.notStrictEqual(err.selfSkip, true,
      'a real block must still count, or genuine outages stop being visible');
  });
});
