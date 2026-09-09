/**
 * Two guards that stop a WIDER proxy pool from making things worse.
 *
 * Growing the ISP pool from 10 exits to 30 divides the proxied rate, but two paths do not
 * benefit from that and get more dangerous as the query list grows:
 *
 *  1. Amazon's direct fallback. Every exit that fails falls through to ONE address — the same
 *     Railway IP Amazon blocked for 14 hours at 0.67 req/s. The worse the exits are doing, the
 *     harder that leg runs: at 13 queries per poll a bad patch lands 2.17 req/s on it.
 *
 *  2. Costco's search fan-out. It fired EVERY query at once, which was fine at 4 and is 13
 *     simultaneous connections every 5s now — and getNextIspProxy pins Costco to one sticky
 *     exit, so extra exits do not divide it. "Failed to connect to the server" is exactly how
 *     that fails, and is how this store has been failing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// A real pool, set BEFORE the adapters are required. amazon.js destructures
// getIspProxyRoundRobin at require time, so stubbing the module property afterwards has no
// effect — the binding is already captured. Driving the real selector is the honest test
// anyway. 'nopool' gets an explicit empty array, which is how a retailer ends up with no exits.
process.env.ISP_PROXY_CONFIG = JSON.stringify({
  isp: {
    proxies: ['http://u:p@10.0.0.1:1', 'http://u:p@10.0.0.2:1'],
    cooldownMs: 1800000,
    retailerPools: { amazon: [0, 1], nopool: [] },
  },
});

const AmazonAdapter = require('../src/adapters/amazon');
const CostcoAdapter = require('../src/adapters/costco');

describe('amazon: the direct fallback is paced, because it is one address', () => {
  function adapter(id = 'amazon') {
    const a = new AmazonAdapter({ id, name: 'Amazon', url: 'https://www.amazon.ca', intervalMs: 6000 });
    a._logSearchRate = () => {};
    return a;
  }

  test('with an ISP pool, a second direct fallback inside the interval is skipped', async () => {
    const a = adapter();
    const seen = [];
    a._searchOnce = async (url, proxyUrl) => { seen.push(proxyUrl); return null; }; // every exit fails
    await a._freeSearch('pokemon tcg');
    await a._freeSearch('pokemon tin');
    await a._freeSearch('pokemon blister pack');
    const direct = seen.filter((p) => p === null).length;
    assert.strictEqual(direct, 1, `only one direct request per interval, got ${direct}`);
    assert.ok(seen.filter((p) => p !== null).length >= 3, 'every attempt still tried an exit first');
  });

  test('with NO ISP pool, direct is never throttled — it is the only route there is', async () => {
    const a = adapter('nopool');
    const seen = [];
    a._searchOnce = async (url, proxyUrl) => { seen.push(proxyUrl); return null; };
    await a._freeSearch('a'); await a._freeSearch('b'); await a._freeSearch('c');
    assert.strictEqual(seen.filter((p) => p === null).length, 3, 'must not disable search when unproxied');
  });

  test('a successful proxied search never reaches the direct leg', async () => {
    const a = adapter();
    const seen = [];
    a._searchOnce = async (url, proxyUrl) => { seen.push(proxyUrl); return '<html>' + 'x'.repeat(60000) + '</html>'; };
    await a._freeSearch('pokemon tcg');
    assert.strictEqual(seen.filter((p) => p === null).length, 0);
  });

  test('the pace resets once the interval has elapsed', async () => {
    const a = adapter();
    const seen = [];
    a._searchOnce = async (url, proxyUrl) => { seen.push(proxyUrl); return null; };
    await a._freeSearch('one');
    a._lastDirectAt = Date.now() - 7000;   // one interval later
    await a._freeSearch('two');
    assert.strictEqual(seen.filter((p) => p === null).length, 2, 'not a permanent block, just a pace');
  });
});

describe('costco: search queries rotate instead of firing all at once', () => {
  function adapter(queries) {
    const a = new CostcoAdapter({ id: 'costco', name: 'Costco', url: 'https://www.costco.ca', intervalMs: 5000 });
    a.searchQueries = queries;
    a.scanSitemaps = async () => {};
    a.lastSitemapScan = Date.now();
    a._fetchProductPages = async () => {};
    return a;
  }
  const QUERIES = Array.from({ length: 13 }, (_, i) => `q${i}`);

  test('one poll issues the per-poll cap, not the whole list', async () => {
    const a = adapter(QUERIES);
    const sent = [];
    a._searchOnce = async (q) => { sent.push(q); return []; };
    await a.fetchProducts();
    assert.ok(sent.length <= 4, `expected at most 4 searches per poll, got ${sent.length}`);
    assert.ok(sent.length > 0, 'but it must still search');
  });

  test('every query is still covered as polls rotate', async () => {
    const a = adapter(QUERIES);
    const seen = new Set();
    a._searchOnce = async (q) => { seen.add(q); return []; };
    for (let i = 0; i < Math.ceil(QUERIES.length / 4); i++) await a.fetchProducts();
    assert.strictEqual(seen.size, QUERIES.length, 'a rotating slice must still reach every query');
  });

  test('the cursor advances rather than repeating the head of the list', async () => {
    const a = adapter(QUERIES);
    const first = []; const second = [];
    a._searchOnce = async (q) => { first.push(q); return []; };
    await a.fetchProducts();
    a._searchOnce = async (q) => { second.push(q); return []; };
    await a.fetchProducts();
    assert.notDeepStrictEqual(first, second, 'successive polls must not repeat the same slice');
  });
});
