/**
 * A proxy exit that cannot be reached must be retired, not used forever.
 *
 * Measured on the live monitor 2026-09-11. Costco's only-used ISP exit stopped accepting
 * connections mid-process, and the store went blind for hours while three healthy siblings sat
 * idle:
 *
 *   Costco Canada: watchlist fast-poll error: ... connect EADDRNOTAVAIL 143.14.236.215:61234
 *   Stealth: error on https://gdx-api.costco.com/...: Failed to connect to the server.
 *   Costco Canada: found 0 products in 5ms
 *
 * 83 failures in one window, all to that same address, each returning in 5-13ms because the
 * socket never left the container. /api/stats/proxy showed exit #6 with 15,528 requests and
 * exits #7/#10/#11 with ZERO. Sibling addresses in the same range serving other retailers were
 * fine, so the provider was up — that one route was not.
 *
 * Only markProxyBlocked() releases the sticky pin and rotates. Neither `EADDRNOTAVAIL` nor
 * impit's `Failed to connect to the server.` matched any block test, so the pin held on a dead
 * exit indefinitely. The store reported consecutiveErrors:0 the whole time, because the search
 * path swallows rejections — so nothing anywhere said "this is broken" except the freshness
 * canary, which is what eventually caught it at zeroFreshPolls:169.
 *
 * The asymmetry that decides the design: rotating on a transient blip is cheap (a sibling takes
 * over, the cooldown auto-recovers, and getNextIspProxy force-revives the least-blocked exit if
 * a pool goes fully dark). NOT rotating costs an entire store until a human notices.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const BaseAdapter = require('../src/adapters/base');

const adapter = () => new BaseAdapter({
  id: 'costco', name: 'Costco Canada', url: 'https://www.costco.ca', intervalMs: 5000,
  proxyTier: 'isp',
});

const isBlock = (msg) => adapter()._isProxyBlock(new Error(msg));

describe('an unreachable exit is recognised as a reason to rotate', () => {
  test('the exact error that took Costco down', () => {
    assert.strictEqual(
      isBlock('request to https://www.costco.ca/p/-/x/4201042492 failed, reason: '
        + 'connect EADDRNOTAVAIL 143.14.236.215:61234 - Local (0.0.0.0:0)'),
      true, 'this ran 83 times in one window and rotated nothing');
  });

  test('impit\'s wording for the same failure', () => {
    // The search lane is the one that matters most for Costco and it goes through impit, which
    // reports connect failures with this phrase rather than an errno.
    assert.strictEqual(isBlock('Failed to connect to the server. '), true);
  });

  test('the other unreachable-route errnos', () => {
    for (const e of ['EHOSTUNREACH', 'ENETUNREACH', 'ECONNREFUSED', 'socket hang up']) {
      assert.strictEqual(isBlock(`connect ${e} 1.2.3.4:1234`), true, e);
    }
  });
});

describe('the site refusing us still counts, as it always did', () => {
  for (const m of ['403 Forbidden', 'HTTP 503', 'Access Denied', 'CAPTCHA required',
    'Blocked by the site', 'connection refused']) {
    test(`"${m}"`, () => assert.strictEqual(isBlock(m), true));
  }
});

describe('ordinary failures must NOT retire a healthy exit', () => {
  // Over-marking is cheap but not free: a 30-minute cooldown on an exit that was fine wastes
  // capacity. These are faults of the request or the site, not of the route to the proxy.
  for (const m of ['HTTP 404', 'HTTP 500', 'Unexpected token < in JSON at position 0',
    'Adapter timeout after 180000ms', 'parsed 0 products']) {
    test(`"${m}" is not a proxy block`, () => assert.strictEqual(isBlock(m), false));
  }

  test('an error with no message does not throw or match', () => {
    assert.strictEqual(adapter()._isProxyBlock(new Error()), false);
    assert.strictEqual(adapter()._isProxyBlock({}), false);
  });
});
