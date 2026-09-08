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
    await assert.rejects(() => a._fetchListing('https://www.ebgames.ca/b'), /403/,
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
