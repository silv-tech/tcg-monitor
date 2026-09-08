/**
 * The ScraperAPI spend guard must watch the BILLED figure, not our local counter.
 *
 * The local creditUsage counter drifted/reset once (read ~30k while the dashboard was 145k),
 * which left the 90% auto-pause blind — it would never fire near the real 1M limit. The guard
 * now anchors to ScraperAPI's own /account endpoint (requestCount / requestLimit), falling back
 * to the local counter only until the first successful account call.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// scraper-api reads SCRAPER_API_KEY at load; refreshAccountUsage is a no-op without it.
process.env.SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'test-key';
const scraperApi = require('../src/utils/scraper-api');

describe('scraperapi budget anchored to /account', () => {
  let realFetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  // Ordered low→high on purpose: budgetPaused is module state and only latches upward.
  test('before any account call, falls back to the local counter', () => {
    const st = scraperApi.getBudgetStatus();
    assert.strictEqual(st.source, 'local', 'no dashboard figure yet');
  });

  test('after a refresh it reports the real billed figure, not the local counter', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ requestCount: 500000, requestLimit: 1000000 }) });
    await scraperApi.refreshAccountUsage(true);
    const st = scraperApi.getBudgetStatus();
    assert.strictEqual(st.source, 'dashboard');
    assert.strictEqual(st.used, 500000, 'the real requestCount');
    assert.strictEqual(st.budget, 1000000, 'the real requestLimit overrides SCRAPER_BUDGET');
    assert.strictEqual(st.paused, false, '50% is nowhere near the pause line');
  });

  test('pauses when the REAL figure crosses 90% (the whole point of the fix)', async () => {
    global.fetch = async () => ({ ok: true, json: async () => ({ requestCount: 950000, requestLimit: 1000000 }) });
    await scraperApi.refreshAccountUsage(true);
    const st = scraperApi.getBudgetStatus();
    assert.strictEqual(st.paused, true, 'guard fires on the billed number, not the drifting local one');
  });

  test('a failed account call never throws and keeps the last known figure', async () => {
    global.fetch = async () => { throw new Error('network'); };
    await assert.doesNotReject(scraperApi.refreshAccountUsage(true));
    const st = scraperApi.getBudgetStatus();
    assert.strictEqual(st.source, 'dashboard', 'still using the last good billed figure');
  });
});
