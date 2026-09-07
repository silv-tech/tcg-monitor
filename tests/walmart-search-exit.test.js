/**
 * Walmart search must not go out through the metered residential exit.
 *
 * Measured live on 2026-09-07 against the deployed configuration:
 *   - residential -> walmart.ca/search redirects to /en/search and returns PerimeterX's
 *                    /blocked page: HTTP 200, 7,545 bytes, "Verify Your Identity", no
 *                    __NEXT_DATA__. Production logged "search — 0/4 stealth (0% avg),
 *                    0 products" on every poll, because stealthGet returns null on that
 *                    body and a null is indistinguishable from an empty result.
 *   - ISP [0,1,2] -> HTTP 200, 564-576KB, __NEXT_DATA__ parsed, 46 items, 4.0-4.6s.
 *                    All three addresses, not a lucky one.
 *
 * It is also the heaviest thing the system sends: a search page is 570KB decompressed and
 * ~140KB on the wire (measured content-encoding: gzip, 81,108 wire vs 329,868 decompressed
 * on the comparable product page), four of them every six seconds. Residential is billed per
 * GB; these ISP addresses are flat-rate.
 *
 * The trap this file exists to pin: Walmart's proxyTier is 'residential' and must STAY that
 * way, because its watchlist legs genuinely need residential addresses. getProxy() reads that
 * tier, so routing search through getProxy() silently keeps it on the metered, blocked exit —
 * which is what commit be769ea did while its message said otherwise. Search is the one Walmart
 * path that has to ask for the ISP pool by name.
 */

// Index 3 belongs to nobody and index 4 is Costco's, so "stayed inside walmart's pool" is a
// real assertion rather than "there was only one place to go".
process.env.ISP_PROXY_CONFIG = JSON.stringify({
  isp: {
    proxies: [
      'http://u:p@143.14.233.74:61234',
      'http://u:p@143.14.233.189:61234',
      'http://u:p@143.14.236.54:61234',
      'http://u:p@143.14.236.86:61234',
      'http://u:p@143.14.236.215:61234',
    ],
    retailerPools: { walmart: [0, 1, 2], costco: [4] },
  },
});
process.env.PROXY_RESIDENTIAL_URL = 'http://u:p@immaculateresis.immaculateips.com:823';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const WalmartAdapter = require('../src/adapters/walmart');
const { getIspProxyForLane } = require('../src/core/proxy');
const { searchQueries, setQueries } = require('../src/config/products.json');

const RESIDENTIAL = process.env.PROXY_RESIDENTIAL_URL;
const WALMART_POOL = [
  'http://u:p@143.14.233.74:61234',
  'http://u:p@143.14.233.189:61234',
  'http://u:p@143.14.236.54:61234',
];
const COSTCO_EXIT = 'http://u:p@143.14.236.215:61234';
const QUERIES = [...searchQueries, ...(setQueries || [])];

function adapter(id = 'walmart') {
  return new WalmartAdapter({
    id,
    name: 'Walmart Canada',
    url: 'https://www.walmart.ca',
    intervalMs: 6000,
    proxyTier: 'residential',
  });
}

// getIspProxyForLane hands back the live pool entry, so a test that benches an exit has to
// put it back or the cooldown leaks into the next test.
const benched = [];
function bench(lane) {
  const picked = getIspProxyForLane('walmart', lane);
  benched.push(picked.proxyObj);
  picked.proxyObj.blockedUntil = Date.now() + 60000;
  picked.proxyObj.healthy = false;
  return picked.url;
}
afterEach(() => {
  for (const p of benched.splice(0)) { p.blockedUntil = 0; p.healthy = true; }
});

describe('walmart search exit', () => {
  test('the real query set leaves through walmart own ISP pool', () => {
    assert.ok(QUERIES.length >= 2, 'expected the real query set from products.json');
    const a = adapter();
    for (const q of QUERIES) {
      const exit = a._searchExit(`q:${q}`);
      assert.notStrictEqual(exit, RESIDENTIAL,
        `"${q}" went out through the metered exit, which PerimeterX answers with /blocked`);
      assert.notStrictEqual(exit, COSTCO_EXIT, `"${q}" took Costco's address`);
      assert.ok(WALMART_POOL.includes(exit), `"${q}" used ${exit}, outside walmart's pool`);
    }
  });

  test('the queries spread across the pool rather than bursting from one address', () => {
    const a = adapter();
    const exits = new Set(QUERIES.map((q) => a._searchExit(`q:${q}`)));
    assert.ok(exits.size > 1,
      `all ${QUERIES.length} queries landed on one exit. Parallel queries from a single ` +
      'address is the burst that drove stealth success from 86% to ~50%. If products.json ' +
      'changed, the lane hash has collided — vary a query string or widen the pool.');
  });

  test('a lane is stable, so a query does not churn addresses between polls', () => {
    const a = adapter();
    const first = a._searchExit('q:pokemon tcg');
    for (let i = 0; i < 25; i++) {
      assert.strictEqual(a._searchExit('q:pokemon tcg'), first,
        'lanes must be sticky — the background retry clears the exit it believes the query ' +
        'used, and a churning pick would clear a connection that was never opened');
    }
  });

  test('getProxy() still reports residential — the watchlist legs depend on it', () => {
    const a = adapter();
    assert.strictEqual(a.getProxy().url, RESIDENTIAL,
      'flipping proxyTier to isp would move the watchlist JSON and page legs too, and those ' +
      'were measured working on residential');
  });

  test('a benched exit is skipped, not handed out again', () => {
    const a = adapter();
    const lane = 'q:pokemon tcg';
    const first = bench(lane);
    const second = a._searchExit(lane);
    assert.notStrictEqual(second, first, 'a cooling-down exit was handed out again');
    assert.ok(WALMART_POOL.includes(second), `fell out of the pool to ${second}`);
  });

  test('with the whole pool benched, search still uses the pool and not the metered exit', () => {
    const a = adapter();
    // Shops share these three addresses, so a shop-induced cooldown can bench all of them.
    // Falling back to residential there would be the worst of both: metered AND blocked.
    for (let i = 0; i < WALMART_POOL.length; i++) bench(`q:bench-${i}`);
    const exit = a._searchExit('q:pokemon tcg');
    assert.notStrictEqual(exit, RESIDENTIAL);
    assert.ok(WALMART_POOL.includes(exit), `fell out of the pool to ${exit}`);
  });

  test('a retailer with no dedicated pool uses the shared pool, still never residential', () => {
    const a = adapter('someshop');
    const exit = a._searchExit('q:pokemon tcg');
    assert.notStrictEqual(exit, RESIDENTIAL);
    assert.notStrictEqual(exit, COSTCO_EXIT, 'the shared pool must exclude protected retailers');
  });

  test('falls back to residential when no ISP pool is configured at all', () => {
    // A separate process: the pool is read once at require time, so emptying it here would
    // not un-load the module. This is the local-dev shape, where there are no ISP addresses.
    const walmartPath = path.resolve(__dirname, '../src/adapters/walmart.js');
    const script = [
      'process.env.ISP_PROXY_CONFIG = \'{"isp":{"proxies":[]}}\';',
      `process.env.PROXY_RESIDENTIAL_URL = ${JSON.stringify(RESIDENTIAL)};`,
      `const W = require(${JSON.stringify(walmartPath)});`,
      "const a = new W({ id: 'walmart', name: 'w', url: 'https://www.walmart.ca', intervalMs: 6000, proxyTier: 'residential' });",
      // The logger writes its boot line to stdout, so the answer is marked rather than
      // assumed to be the only thing printed.
      "process.stdout.write('EXIT<' + a._searchExit('q:pokemon tcg') + '>');",
    ].join('\n');
    const raw = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const out = (raw.match(/EXIT<([^>]*)>/) || [])[1];
    assert.strictEqual(out, RESIDENTIAL,
      'with no ISP addresses configured, search must still go out through a proxy');
  });
});
