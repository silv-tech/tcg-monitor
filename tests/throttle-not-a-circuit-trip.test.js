/**
 * Throttling must not trip the circuit breaker.
 *
 * stealth-http answers a 429 with an escalating per-host cooldown, and the scheduler already
 * declined to count its OWN cooldown ("Cooling down ...") as a poll failure. But the 429 that
 * caused the cooldown — "Rate limited (429): ..." — fell through and did count.
 *
 * That turned a thirty-second backoff into a ten-minute blackout: five 429s tripped the
 * breaker, the breaker's recovery probe landed inside the same cooldown and was refused, and
 * it reopened. Kanzen Games spent hours cycling through that while the shop itself was
 * answering 174 products on every poll that got through.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isSelfSkip, isRateLimited } = require('../src/utils/stealth-http');

// Mirrors the scheduler's decision.
const countsAgainstCircuit = (message) => {
  const err = new Error(message);
  return !(isSelfSkip(err) || isRateLimited(err));
};

describe('a throttled poll is not a failed retailer', () => {
  test('the 429 that opened the breaker no longer counts', () => {
    assert.strictEqual(
      countsAgainstCircuit('Rate limited (429): https://kanzengames.com/collections/x/products.json'),
      false, 'this exact message tripped the breaker five times over');
  });

  test('our own cooldown still does not count', () => {
    assert.strictEqual(countsAgainstCircuit('Cooling down 279s after 429: https://x'), false);
  });

  test('a budget skip still does not count', () => {
    assert.strictEqual(countsAgainstCircuit('Rate limited (budget): https://x'), false);
  });
});

describe('real failures still trip it', () => {
  // The breaker exists for stores that are actually broken. Widening the skip must not make
  // it inert.
  const REAL = [
    'getaddrinfo ENOTFOUND kanzengames.com',
    'Adapter timeout after 180000ms',
    'Unexpected token < in JSON at position 0',
    'socket hang up',
    'HTTP 500',
  ];
  for (const message of REAL) {
    test(`counts: ${message.slice(0, 44)}`, () => {
      assert.strictEqual(countsAgainstCircuit(message), true);
    });
  }
});
