/**
 * Amazon coverage: page-2 depth (rate-neutral) + reliable known-ASIN restock sweep.
 *
 * DEPTH: B0H7818RCM ranked ~25/83 (search page 2) and we only ever read page 1, so it was
 * invisible. Fix: relevance queries now walk (query, page-1) then (query, page-2) on the SAME
 * cursor — same number of requests per poll, depth doubled over two passes.
 *
 * SPEED: B0H78BB9TY is tracked but its restock was missed because the AOD known-ASIN sweep
 * restarted at index 0 every pass and broke on throttle, starving the tail. Fix: a persistent
 * cursor that resumes where the last sweep stopped. Both changes are rate-neutral.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');

// The AOD sweep caches the offer-listing id / seller in Redis (fire-and-forget). In a bare
// single-file test run there is no Redis teardown, so that open ioredis handle keeps Node alive
// and the process never exits. Stub the two cache writes to no-ops — they are incidental to what
// these tests assert (page depth + cursor advance), and state stays lazy so nothing else connects.
const state = require('../src/core/state');
state.cacheOfferListingId = async () => {};
state.cacheSellerInfo = async () => {};

function adapter() {
  const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000, proxyTier: 'none' });
  a.searchQueries = ['q0', 'q1', 'q2']; // small list so page cycling is easy to reason about
  a._logSearchRate = () => {};
  a._recordSearchResult = () => {};
  a.reportFreshness = () => {};
  a._searchSuccessRate = () => 1;
  return a;
}

describe('amazon depth: relevance queries cover page 1 AND page 2 (rate-neutral)', () => {
  test('over enough polls, every query is fetched at page 1 and page 2 — with the same reqs/poll', async () => {
    const a = adapter();
    // QUERIES_PER_POLL defaults to 1 relevance + 1 newest probe = 2 requests/poll.
    const calls = [];
    a._freeSearch = async (query, newest, page) => { calls.push({ query, newest, page }); return []; };
    // Run a full cycle of the (query × 2 pages) list: 3 queries × 2 pages = 6 relevance slots.
    for (let i = 0; i < 6; i++) await a._runDiscovery({});

    const relevance = calls.filter(c => !c.newest);
    const newest = calls.filter(c => c.newest);
    // Rate-neutral: exactly one relevance + one newest probe per poll.
    assert.strictEqual(relevance.length, 6, 'one relevance request per poll (unchanged)');
    assert.strictEqual(newest.length, 6, 'one newest probe per poll (unchanged)');
    // Newest probe never goes past page 1.
    assert.ok(newest.every(c => c.page === 1), 'newest probe stays on page 1');
    // Every query got BOTH page 1 and page 2 on the relevance path.
    for (const q of a.searchQueries) {
      const pages = new Set(relevance.filter(c => c.query === q).map(c => c.page));
      assert.ok(pages.has(1) && pages.has(2), `query ${q} must be read at page 1 AND page 2 — got ${[...pages]}`);
    }
  });
});

describe('amazon speed: AOD sweep uses a persistent cursor (no restart-at-0 starvation)', () => {
  function known(a, n) {
    for (let i = 0; i < n; i++) a._knownProducts.set('A' + i, { sku: 'A' + i, name: 'Pokemon TCG Box ' + i, category: 'pokemon', price: 10, inStock: false });
  }

  test('a throttle-break resumes at the tail on the next sweep instead of re-walking the front', async () => {
    const a = adapter();
    known(a, 10);
    const checked = [];
    // Simulate AOD throttling after 2 checks each sweep (so it breaks and cursor must advance).
    let callsThisSweep = 0;
    a._stealthCheckAsin = async (asin) => {
      checked.push(asin);
      callsThisSweep++;
      if (callsThisSweep >= 2) { a._lastFetchThrottled = true; return null; } // 503-like
      a._lastFetchThrottled = false;
      return { price: 10, inStock: true, olid: 'o', name: 'Pokemon TCG Box' };
    };
    // Two 503s trip the cooldown and break the pass. Clear cooldown between sweeps so we can see resume.
    for (let s = 0; s < 4; s++) { a._aodCooldownUntil = 0; callsThisSweep = 0; await a._monitorKnownAsins({}); }

    // Without a persistent cursor this would be ['A0','A1','A0','A1',...] forever (tail starved).
    // With the cursor it must advance and eventually reach the tail (A8/A9).
    const reachedTail = checked.some(x => x === 'A8' || x === 'A9');
    assert.ok(reachedTail, `cursor must reach the tail; checked=${JSON.stringify(checked)}`);
    // And it must not be stuck only on A0/A1.
    assert.ok(new Set(checked).size > 2, 'more than the first two ASINs get checked over sweeps');
  });

  test('a clean full pass still covers every ASIN and wraps the cursor back', async () => {
    const a = adapter();
    known(a, 5);
    const checked = [];
    a._stealthCheckAsin = async (asin) => { checked.push(asin); a._lastFetchThrottled = false; return { price: 10, inStock: true, olid: 'o', name: 'Pokemon TCG Box' }; };
    await a._monitorKnownAsins({});
    assert.strictEqual(new Set(checked).size, 5, 'a clean pass checks all 5');
    assert.strictEqual(a._aodCursor % 5, 0, 'cursor wraps back to start after a full pass');
  });
});
