/**
 * Walmart search must send impit's own Chrome headers, not stealthGet's navigation block.
 *
 * This is the fault that kept search at "0/4 stealth, 0 products" for a full day while every
 * other explanation looked plausible. It was not the proxy tier, not the exit addresses, and
 * not the request rate — all three were investigated, changed, and deployed first.
 *
 * impit spoofs Chrome's TLS fingerprint and emits the headers real Chrome sends alongside it.
 * stealthGet's default path replaces those with a hand-assembled set (Accept, Sec-Fetch-*,
 * Cache-Control: no-cache, Upgrade-Insecure-Requests). The ClientHello then says Chrome while
 * the headers do not match one, and PerimeterX answers that mismatch with a 7,545-byte
 * /blocked page — HTTP 200, no captcha marker, no __NEXT_DATA__. stealthGet returns null on
 * it and a null is indistinguishable from an empty result, so nothing is ever logged as an
 * error. That silence is what made this cost a day.
 *
 * Measured on 143.14.236.86, requests minutes apart on the same address:
 *   impit's own headers          -> 200, 576,567 bytes, 46 items
 *   stealthGet default headers   -> 200,   7,545 bytes, blocked
 *   default minus Cache-Control  -> 200,   7,545 bytes, blocked   (it is the whole set)
 * Then through this very function, alternating with a bare client at 30s spacing:
 *   stealthGet + rawHeaders      -> 3/3 success, 46 items each
 *
 * The Amazon monitor hit the identical failure: these defaults made amazon.ca return a 3.7KB
 * "continue shopping" interstitial that read as a parse miss. It was fixed there with
 * rawHeaders and plain navigation headers. Search needed the same and did not have it.
 */

process.env.ISP_PROXY_CONFIG = JSON.stringify({
  isp: {
    proxies: ['http://u:p@143.14.233.74:61234', 'http://u:p@143.14.233.189:61234'],
    retailerPools: { walmart: [0, 1] },
  },
});
process.env.PROXY_RESIDENTIAL_URL = 'http://u:p@immaculateresis.immaculateips.com:823';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Patch the module's export BEFORE the adapter requires it — walmart.js destructures
// stealthGet at load time, so a later patch would never be seen.
const stealthHttp = require('../src/utils/stealth-http');
const calls = [];
stealthHttp.stealthGet = async (url, opts) => {
  calls.push({ url, opts });
  return null; // the parse path is not what this file is about
};

const WalmartAdapter = require('../src/adapters/walmart');

function adapter() {
  return new WalmartAdapter({
    id: 'walmart',
    name: 'Walmart Canada',
    url: 'https://www.walmart.ca',
    intervalMs: 6000,
    proxyTier: 'residential',
  });
}

describe('walmart search request shape', () => {
  test('search asks for raw headers, so impit sends Chrome\'s own', async () => {
    calls.length = 0;
    await adapter()._stealthSearch('pokemon tcg');
    assert.strictEqual(calls.length, 1, 'expected exactly one request');
    assert.strictEqual(calls[0].opts.rawHeaders, true,
      'without rawHeaders, stealthGet overwrites impit\'s Chrome headers with its navigation ' +
      'block, and PerimeterX answers the TLS/header mismatch with /blocked — 7,545 bytes, ' +
      'HTTP 200, no error anywhere. That is a silent outage, not a visible one.');
  });

  test('search sends no headers of its own, leaving impit\'s intact', async () => {
    calls.length = 0;
    await adapter()._stealthSearch('pokemon tcg');
    const headers = calls[0].opts.headers;
    assert.ok(headers === undefined || Object.keys(headers).length === 0,
      `search supplied headers (${JSON.stringify(headers)}). With rawHeaders they pass through ` +
      'verbatim, so any hand-written header re-creates the mismatch this test exists to prevent.');
  });

  test('the request still goes to the search URL through a proxy', async () => {
    calls.length = 0;
    await adapter()._stealthSearch('one piece card game');
    assert.match(calls[0].url, /^https:\/\/www\.walmart\.ca\/search\?q=one%20piece%20card%20game$/);
    assert.ok(calls[0].opts.proxyUrl, 'search must not go out unproxied');
    assert.strictEqual(calls[0].opts.lane, 'q:one piece card game',
      'the lane keeps parallel queries on separate connections');
  });
});
