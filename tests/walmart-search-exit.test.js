/**
 * Walmart search: which exit it leaves through, and how much of it leaves at once.
 *
 * Two facts measured live on 2026-09-07, both of which this file exists to hold in place:
 *
 * 1. The residential exit cannot do this at all. walmart.ca/search redirects to /en/search and
 *    returns PerimeterX's /blocked page — HTTP 200, 7,545 bytes, "Verify Your Identity", no
 *    __NEXT_DATA__. stealthGet returns null on that body and a null is indistinguishable from
 *    an empty result, which is why production logged "search — 0/4 stealth, 0 products" for a
 *    day with no error anywhere. The ISP addresses answer 200 with 46 items in 4.0-4.6s.
 *
 * 2. The limit is per ADDRESS, and it is low. 143.14.233.74 was served /blocked while taking
 *    0.061 req/s — one search request every 16 seconds — at the same moment that five sibling
 *    addresses in the same /16, with no walmart.ca history, all answered 200 with 46 items.
 *    So spreading across addresses buys headroom and subnet-level aggregation is not happening.
 *
 * Together those give the rule: send fewer queries per poll, and divide them across the whole
 * pool. A stable per-query exit would defeat the second half — only as many addresses as there
 * are queries would ever be used, and a bigger pool would buy nothing.
 */

process.env.ISP_PROXY_CONFIG = JSON.stringify({
  isp: {
    proxies: [
      'http://u:p@143.14.233.74:61234',
      'http://u:p@143.14.233.189:61234',
      'http://u:p@143.14.236.54:61234',
      'http://u:p@143.14.236.86:61234',
      'http://u:p@143.14.236.215:61234',
    ],
    // Index 3 belongs to nobody and 4 is Costco's, so "stayed inside walmart's pool" is a real
    // assertion rather than "there was nowhere else to go".
    retailerPools: { walmart: [0, 1, 2], costco: [4] },
  },
});
process.env.PROXY_RESIDENTIAL_URL = 'http://u:p@immaculateresis.immaculateips.com:823';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const WalmartAdapter = require('../src/adapters/walmart');
const { getIspProxyRoundRobin, ispPoolSize } = require('../src/core/proxy');
const logger = require('../src/monitoring/logger');
const { searchQueries, setQueries } = require('../src/config/products.json');

const RESIDENTIAL = process.env.PROXY_RESIDENTIAL_URL;
const WALMART_POOL = [
  'http://u:p@143.14.233.74:61234',
  'http://u:p@143.14.233.189:61234',
  'http://u:p@143.14.236.54:61234',
];
const COSTCO_EXIT = 'http://u:p@143.14.236.215:61234';
const QUERIES = [...searchQueries, ...(setQueries || [])];

function adapter(overrides = {}) {
  return new WalmartAdapter({
    id: 'walmart',
    name: 'Walmart Canada',
    url: 'https://www.walmart.ca',
    intervalMs: 6000,
    proxyTier: 'residential',
    ...overrides,
  });
}

// The picker hands back the live pool entry, so a test that benches one must put it back.
const benched = [];
function benchOne() {
  const picked = getIspProxyRoundRobin('walmart');
  benched.push(picked.proxyObj);
  picked.proxyObj.blockedUntil = Date.now() + 60000;
  picked.proxyObj.healthy = false;
  return picked.url;
}
afterEach(() => {
  for (const p of benched.splice(0)) { p.blockedUntil = 0; p.healthy = true; }
});

describe('walmart search exit', () => {
  test('search never leaves through the metered residential exit', () => {
    const a = adapter();
    for (let i = 0; i < 20; i++) {
      const exit = a._searchExit();
      assert.notStrictEqual(exit, RESIDENTIAL,
        'search went out through the exit PerimeterX answers with /blocked, and which is billed per GB');
      assert.ok(WALMART_POOL.includes(exit), `used ${exit}, outside walmart's pool`);
      assert.notStrictEqual(exit, COSTCO_EXIT, "took Costco's protected address");
    }
  });

  test('successive requests spread across the WHOLE pool, not a subset', () => {
    const a = adapter();
    const seen = new Set();
    for (let i = 0; i < WALMART_POOL.length * 3; i++) seen.add(a._searchExit());
    assert.strictEqual(seen.size, WALMART_POOL.length,
      `only ${seen.size} of ${WALMART_POOL.length} exits were used. Per-address rate is the ` +
      'measured constraint (0.061 req/s blocks), so an unused address is headroom thrown away ' +
      'and widening the pool would buy nothing.');
  });

  test('the spread is even — no address carries a disproportionate share', () => {
    const a = adapter();
    const counts = new Map();
    const N = WALMART_POOL.length * 10;
    for (let i = 0; i < N; i++) {
      const e = a._searchExit();
      counts.set(e, (counts.get(e) || 0) + 1);
    }
    const expected = N / WALMART_POOL.length;
    for (const [exit, n] of counts) {
      assert.ok(Math.abs(n - expected) <= 1,
        `${exit} took ${n} of ${N} requests, expected ~${expected} — an uneven split means the ` +
        'busiest address hits the block threshold first');
    }
  });

  test('a benched exit is skipped, and the rest keep serving', () => {
    const a = adapter();
    const down = benchOne();
    for (let i = 0; i < 12; i++) {
      const exit = a._searchExit();
      assert.notStrictEqual(exit, down, 'a cooling-down address was handed out again');
      assert.ok(WALMART_POOL.includes(exit), `fell out of the pool to ${exit}`);
    }
  });

  test('with the whole pool benched, search stays on ISP rather than falling to the meter', () => {
    const a = adapter();
    // Shops share these addresses and can bench them via markProxyBlocked, so all-down is real.
    // Falling back to residential there would be the worst case: metered AND blocked.
    for (let i = 0; i < WALMART_POOL.length; i++) benchOne();
    const exit = a._searchExit();
    assert.notStrictEqual(exit, RESIDENTIAL);
    assert.ok(WALMART_POOL.includes(exit), `fell out of the pool to ${exit}`);
  });

  test('getProxy() still reports residential — the watchlist legs depend on it', () => {
    assert.strictEqual(adapter().getProxy().url, RESIDENTIAL,
      'flipping proxyTier to isp would move the watchlist JSON and page legs too, and those ' +
      'were measured working on residential at 0.58-2.0s');
  });

  test('falls back to residential when no ISP pool is configured at all', () => {
    // A separate process: the pool is read once at require time, so emptying it here would not
    // un-load the module. This is the local-dev shape, with no ISP addresses at all.
    const script = [
      'process.env.ISP_PROXY_CONFIG = \'{"isp":{"proxies":[]}}\';',
      `process.env.PROXY_RESIDENTIAL_URL = ${JSON.stringify(RESIDENTIAL)};`,
      `const W = require(${JSON.stringify(path.resolve(__dirname, '../src/adapters/walmart.js'))});`,
      "const a = new W({ id: 'walmart', name: 'w', url: 'https://www.walmart.ca', intervalMs: 6000, proxyTier: 'residential' });",
      // The logger prints its own boot line, so the answer is marked rather than assumed to be
      // the only thing on stdout.
      "process.stdout.write('EXIT<' + a._searchExit() + '>');",
    ].join('\n');
    const raw = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.strictEqual((raw.match(/EXIT<([^>]*)>/) || [])[1], RESIDENTIAL,
      'with no ISP addresses configured, search must still go out through a proxy');
  });
});

describe('walmart search query rotation', () => {
  test('a poll sends only its slice, not the whole query set', () => {
    const a = adapter({ timing: { queriesPerPoll: 2 } });
    assert.ok(QUERIES.length > 2, 'expected the real query set to be worth rotating');
    assert.strictEqual(a._nextQueryGroup().length, 2);
  });

  test('rotation covers every query, in order, then wraps', () => {
    const a = adapter({ timing: { queriesPerPoll: 1 } });
    const sent = [];
    for (let i = 0; i < QUERIES.length; i++) sent.push(...a._nextQueryGroup());
    assert.deepStrictEqual(sent, QUERIES,
      'a query that never gets sent is a category of product that never gets alerted on');
    assert.deepStrictEqual(a._nextQueryGroup(), [QUERIES[0]], 'the cursor must wrap');
  });

  test('full coverage takes ceil(queries / perPoll) polls', () => {
    for (const perPoll of [1, 2, 3]) {
      const a = adapter({ timing: { queriesPerPoll: perPoll } });
      const polls = Math.ceil(QUERIES.length / perPoll);
      const seen = new Set();
      for (let i = 0; i < polls; i++) for (const q of a._nextQueryGroup()) seen.add(q);
      assert.strictEqual(seen.size, QUERIES.length,
        `at ${perPoll}/poll, ${polls} polls did not cover all ${QUERIES.length} queries`);
    }
  });

  test('perPoll is clamped to at least 1 and at most the query count', () => {
    assert.strictEqual(adapter({ timing: { queriesPerPoll: 0 } }).queriesPerPoll >= 1, true);
    assert.strictEqual(adapter({ timing: { queriesPerPoll: -3 } }).queriesPerPoll >= 1, true);
    assert.strictEqual(adapter({ timing: { queriesPerPoll: 999 } }).queriesPerPoll, QUERIES.length);
  });

  test('sending everything every poll is still expressible, and is what got blocked', () => {
    const a = adapter({ timing: { queriesPerPoll: QUERIES.length } });
    assert.deepStrictEqual(a._nextQueryGroup(), QUERIES);
  });
});

describe('walmart search rate self-check', () => {
  function capture(fn) {
    const warns = [];
    const infos = [];
    const ow = logger.warn, oi = logger.info;
    logger.warn = (m) => warns.push(String(m));
    logger.info = (m) => infos.push(String(m));
    try { fn(); } finally { logger.warn = ow; logger.info = oi; }
    return { warns, infos };
  }

  test('warns when the configured rate per exit exceeds the safe target', () => {
    // 3 queries / 6s over 3 exits = 0.167 req/s each — nearly 3x the 0.061 that blocked .74
    const a = adapter({ timing: { queriesPerPoll: 3 } });
    const { warns } = capture(() => a._logSearchRate());
    assert.strictEqual(warns.length, 1, 'an unsafe rate must be warned about, not just logged');
    assert.match(warns[0], /ABOVE/);
    assert.match(warns[0], /0\.167 req\/s per exit/);
  });

  test('logs without warning when the rate is under the target', () => {
    // 1 query / 60s over 3 exits = 0.006 req/s each
    const a = adapter({ intervalMs: 60000, timing: { queriesPerPoll: 1 } });
    const { warns, infos } = capture(() => a._logSearchRate());
    assert.strictEqual(warns.length, 0, `unexpected warning: ${warns[0]}`);
    assert.strictEqual(infos.length, 1);
    assert.match(infos[0], /req\/s per exit/);
  });

  test('reports full-coverage time, so slowing the rate cannot hide the cost', () => {
    const a = adapter({ intervalMs: 6000, timing: { queriesPerPoll: 1 } });
    const { infos, warns } = capture(() => a._logSearchRate());
    const line = (infos[0] || warns[0]) || '';
    assert.match(line, new RegExp(`full coverage ${QUERIES.length * 6}s`),
      'the log must state how long a full rotation takes — that is the alert latency');
  });

  test('the shipped default over a three-exit pool is flagged as too hot', () => {
    // Not a bug in the default — a statement about the hardware. Walmart's pool is three
    // addresses, and even one query per 6s poll divides to 0.056 req/s each, which is the
    // 0.061 that got .74 blocked with no margin at all. The rate is only safe once the pool is
    // widened, and that is a Railway ISP_PROXY_CONFIG change, not a code change. Soaked for 30
    // minutes at 0.033 req/s per exit: 300/300, zero blocks. Eight exits puts the default at
    // 0.021. This test fails the day someone widens the pool — which is exactly when this
    // comment should be revisited rather than left to rot.
    assert.strictEqual(ispPoolSize('walmart'), 3, 'fixture: walmart has three exits');
    const { warns } = capture(() => adapter()._logSearchRate());
    assert.strictEqual(warns.length, 1, 'a rate above the block threshold must not pass silently');
    assert.match(warns[0], /ABOVE/);
    assert.match(warns[0], /0\.056 req\/s per exit/);
    assert.match(warns[0], /widen/, 'the warning must say what to do about it');
  });
});
