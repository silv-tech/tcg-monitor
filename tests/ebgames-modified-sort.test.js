/**
 * EB Games credit optimisation: lean on the recently-modified sort, relax the deep crawl.
 *
 * Verified live 2026-09-08: EB Games bumps a product's write_date on restock/reprice, so
 * restocks surface at the TOP of the write_date-desc ("modified") sort — a page-1 compare of
 * create_date-desc vs write_date-desc shared zero SKUs, the modified sort being entirely older
 * products changed in batches. So the fast poll can catch restocks every cycle by reading a
 * deeper slice of the modified sort, which lets the full-catalogue deep crawl step back from a
 * 5-minute scan to a 30-minute safety net — ~40% of the ScraperAPI spend removed with restocks
 * detected FASTER, not slower.
 *
 * These tests pin the two properties that make that true:
 *   1. the fast poll reads more modified pages than newest ones, newest queued first;
 *   2. the deep crawl's default interval is the relaxed 30 minutes.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// Keep the adapter off the network — _fastPoll's only I/O is _fetchJobs, which we stub, but a
// stray curl in construction/paths must never reach out from a test box that can hit ebgames.ca.
process.env.CURL_BIN = 'tcg-no-such-curl-binary';

const EBGames = require('../src/adapters/ebgames');

function adapter() {
  const a = new EBGames({
    id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca',
    intervalMs: 5000, proxyTier: 'none',
  });
  a._throttle = async () => {};
  return a;
}

describe('ebgames: modified-sort fast poll + relaxed deep crawl', () => {
  let captured;
  function wire(a) {
    // Force the large-category branch so newest+modified pages are both queued.
    a._pageCounts.set('pokemon', 80);
    a._pageCounts.set('onepiece', 80);
    a._fetchJobs = async (jobs) => { captured = jobs; return []; };
  }

  beforeEach(() => { captured = null; });

  test('reads more MODIFIED pages than NEWEST — restocks are caught where they surface', async () => {
    const a = adapter(); wire(a);
    await a._fastPoll();
    const pokeNew = captured.filter(j => j.src.key === 'pokemon' && /create_date/.test(j.url));
    const pokeMod = captured.filter(j => j.src.key === 'pokemon' && /write_date/.test(j.url));
    assert.strictEqual(pokeNew.length, 2, 'pokemon: 2 newest pages (new-listing coverage unchanged)');
    assert.strictEqual(pokeMod.length, 6, 'pokemon: 6 modified pages (restocks concentrate here)');
    assert.ok(pokeMod.length > pokeNew.length, 'the whole point: more modified than newest');
  });

  test('newest pages are queued BEFORE modified pages — new-listing latency is preserved', async () => {
    const a = adapter(); wire(a);
    await a._fastPoll();
    const pokeJobs = captured.filter(j => j.src.key === 'pokemon');
    const lastNewIdx = pokeJobs.map(j => /create_date/.test(j.url)).lastIndexOf(true);
    const firstModIdx = pokeJobs.findIndex(j => /write_date/.test(j.url));
    assert.ok(lastNewIdx < firstModIdx, 'all newest pages precede the modified pages');
  });

  test('a small category never over-requests modified pages beyond its real page count', async () => {
    const a = adapter();
    a._pageCounts.set('pokemon', 80);
    a._pageCounts.set('onepiece', 2); // only 2 real pages, but modifiedPages is 3
    a._fetchJobs = async (jobs) => { captured = jobs; return []; };
    await a._fastPoll();
    const opMod = captured.filter(j => j.src.key === 'onepiece' && /write_date/.test(j.url));
    assert.ok(opMod.length <= 2, 'modified pages are clamped to the real page count');
  });

  test('deep crawl default interval is the relaxed 30 minutes', () => {
    const a = adapter();
    assert.strictEqual(a.deepCrawlIntervalMs, 30 * 60 * 1000,
      'the full-catalogue scan is now a 30-min safety net, not a 5-min primary mechanism');
  });
});
