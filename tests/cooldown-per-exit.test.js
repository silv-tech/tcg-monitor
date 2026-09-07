/**
 * A 429 benches one route, not the whole shop.
 *
 * All ten ISP addresses are allocated to the big four in retailerPools, so the eleven Shopify
 * shops share them. Keying the cooldown on the target host alone meant a 429 taken by ONE of
 * those addresses made the shop unreachable from all ten for up to fifteen minutes. No request
 * went out, so none could succeed, so clearStrikes never ran and the ladder only climbed:
 * Kanzen Games sat in that loop for hours while answering 200 in 0.4s to a direct request.
 *
 * Hobbiesville had identical configuration — same proxyTier, same absence of a dedicated pool
 * — and simply never had an address limited. That was the entire difference between the shop
 * that worked and the shop that did not.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const stealth = require('../src/utils/stealth-http');

const URL_A = 'https://kanzengames.com/collections/pokemon-sealed-in-stock/products.json';
const PROXY_1 = 'http://143.14.232.230:61234';
const PROXY_2 = 'http://143.14.233.74:61234';

beforeEach(() => stealth._resetCooldowns());

describe('a 429 benches only the exit that took it', () => {
  test('the offending exit is put on cooldown', () => {
    stealth.setCooldown(URL_A, 30000, PROXY_1);
    assert.ok(stealth.cooldownRemaining(URL_A, PROXY_1) > 0);
  });

  test('every other exit stays usable — this is the fix', () => {
    stealth.setCooldown(URL_A, 30000, PROXY_1);
    assert.strictEqual(stealth.cooldownRemaining(URL_A, PROXY_2), 0);
    assert.strictEqual(stealth.cooldownRemaining(URL_A, null), 0, 'direct is a route too');
  });

  test('the host is reachable while any exit is free', () => {
    stealth.setCooldown(URL_A, 30000, PROXY_1);
    stealth.setCooldown(URL_A, 30000, PROXY_2);
    assert.ok(stealth.cooldownRemaining(URL_A) > 0, 'both known routes cooling');
    stealth._resetCooldowns();
    stealth.setCooldown(URL_A, 30000, PROXY_1);
    // PROXY_2 has never been used, so nothing records it as cooling.
    assert.strictEqual(stealth.cooldownRemaining(URL_A, PROXY_2), 0);
  });

  test('strikes escalate per route, not globally', () => {
    const a = stealth.setCooldown(URL_A, 1000, PROXY_1);
    const b = stealth.setCooldown(URL_A, 1000, PROXY_1);
    const c = stealth.setCooldown(URL_A, 1000, PROXY_2);
    assert.strictEqual(a.strikes, 1);
    assert.strictEqual(b.strikes, 2, 'the same route escalates');
    assert.strictEqual(c.strikes, 1, 'a fresh route starts clean');
  });

  test('a success clears only that route', () => {
    stealth.setCooldown(URL_A, 30000, PROXY_1);
    stealth.setCooldown(URL_A, 30000, PROXY_2);
    stealth.clearStrikes(URL_A, PROXY_1);
    // clearStrikes resets the ladder; the other route keeps its own count.
    assert.strictEqual(stealth.setCooldown(URL_A, 1000, PROXY_1).strikes, 1,
      'the cleared route starts over');
    assert.strictEqual(stealth.setCooldown(URL_A, 1000, PROXY_2).strikes, 2,
      'the other route keeps the one strike it already had');
  });
});

describe('endpoints on one host stay independent', () => {
  // The existing per-path behaviour must survive: Walmart's GraphQL endpoint being throttled
  // must not silence its search endpoint.
  test('a different path on the same host is unaffected', () => {
    stealth.setCooldown('https://www.walmart.ca/orchestra/graphql', 30000, PROXY_1);
    assert.strictEqual(stealth.cooldownRemaining('https://www.walmart.ca/search', PROXY_1), 0);
  });
});
