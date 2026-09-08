/**
 * Amazon search: spread across ISP exits, and never on the metered pool.
 *
 * Two facts this holds in place.
 *
 * 1. Amazon's search limit is per ADDRESS. Four queries every six seconds from Railway's
 *    single IP — 0.67 req/s — blocked it after roughly fourteen hours, which is why this
 *    adapter dropped to one query per poll and lost coverage. Rotating exits divides the rate
 *    by the pool, so the query list can widen without the per-address rate rising. Verified
 *    live 2026-09-08: amazon.ca search answers 200 through the ISP exits, 38-68 ASINs per
 *    page, 2.0-3.4s — it does not refuse the range, which was the open question.
 *
 * 2. There must be no residential fallback. A search page is ~1.4MB and residential is billed
 *    per GB; four queries every 10s through it is ~48GB/day. A fallback fires precisely when
 *    things are already going wrong, which is when it would run hardest. The ISP exits are
 *    flat-rate, so nothing here is worth paying for.
 *
 * The blocking here is SLOW — fourteen hours — so no unit test and no short soak can prove a
 * rate is safe. What a test can do is stop the routing from silently reverting to one address
 * or to the metered one, which is how both of these were lost before.
 */

process.env.ISP_PROXY_CONFIG = JSON.stringify({
  isp: {
    proxies: [
      'http://u:p@143.14.236.86:61234',
      'http://u:p@143.14.236.170:61234',
      'http://u:p@143.14.236.190:61234',
      'http://u:p@143.14.236.215:61234',
    ],
    retailerPools: { amazon: [0, 1, 2], costco: [3] },
  },
});
process.env.PROXY_RESIDENTIAL_URL = 'http://u:p@immaculateresis.immaculateips.com:823';
process.env.PROXY_RESIDENTIAL_US_URL = 'http://u:p@lavish-us.example:1234';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const stealthHttp = require('../src/utils/stealth-http');
const seen = [];
stealthHttp.stealthGet = async (url, opts) => {
  seen.push({ url, proxyUrl: opts.proxyUrl });
  return null; // every attempt fails, so the fallback chain is fully exercised
};

const AmazonAdapter = require('../src/adapters/amazon');

const AMAZON_POOL = [
  'http://u:p@143.14.236.86:61234',
  'http://u:p@143.14.236.170:61234',
  'http://u:p@143.14.236.190:61234',
];
const RESIDENTIAL = process.env.PROXY_RESIDENTIAL_URL;
const RESIDENTIAL_US = process.env.PROXY_RESIDENTIAL_US_URL;
const COSTCO_EXIT = 'http://u:p@143.14.236.215:61234';

function adapter() {
  return new AmazonAdapter({
    id: 'amazon',
    name: 'Amazon Canada',
    url: 'https://www.amazon.ca',
    intervalMs: 6000,
    proxyTier: 'residential-us',
  });
}

describe('amazon search exit', () => {
  test('search tries an ISP exit first', async () => {
    seen.length = 0;
    await adapter()._freeSearch('pokemon tcg');
    assert.ok(seen.length >= 1);
    assert.ok(AMAZON_POOL.includes(seen[0].proxyUrl),
      `first attempt used ${seen[0].proxyUrl}, not one of amazon's ISP exits`);
  });

  test('search NEVER touches a metered residential exit, even when every attempt fails', async () => {
    seen.length = 0;
    const a = adapter();
    for (const q of ['pokemon tcg', 'pokemon mini tin', 'one piece card game']) await a._freeSearch(q);
    for (const s of seen) {
      assert.notStrictEqual(s.proxyUrl, RESIDENTIAL,
        'a 1.4MB search page went out through the per-GB pool');
      assert.notStrictEqual(s.proxyUrl, RESIDENTIAL_US,
        'a 1.4MB search page went out through the per-GB US pool');
    }
  });

  test('it falls back to direct, not to a paid exit', async () => {
    seen.length = 0;
    await adapter()._freeSearch('pokemon tcg');
    assert.strictEqual(seen[seen.length - 1].proxyUrl, null,
      'the last resort must be the free direct connection');
  });

  test('successive queries rotate across the whole pool', async () => {
    seen.length = 0;
    const a = adapter();
    for (let i = 0; i < 9; i++) await a._freeSearch(`q${i}`);
    const ispUsed = new Set(seen.filter((s) => s.proxyUrl).map((s) => s.proxyUrl));
    assert.strictEqual(ispUsed.size, AMAZON_POOL.length,
      `only ${ispUsed.size} of ${AMAZON_POOL.length} exits were used — per-address rate is the ` +
      'constraint, so an idle exit is headroom thrown away');
  });

  test('it stays inside amazon\'s own pool and off Costco\'s', async () => {
    seen.length = 0;
    const a = adapter();
    for (let i = 0; i < 9; i++) await a._freeSearch(`q${i}`);
    for (const s of seen) {
      assert.notStrictEqual(s.proxyUrl, COSTCO_EXIT, 'took Costco\'s protected address');
    }
  });

  test('the search URL is unchanged', async () => {
    seen.length = 0;
    await adapter()._freeSearch('pokemon mini tin');
    assert.strictEqual(seen[0].url, 'https://www.amazon.ca/s?k=pokemon%20mini%20tin&i=toys');
  });
});
