/**
 * A poll we declined to send must not count against the retailer.
 *
 * This was the loop that kept shops down on 2026-09-05 long after the retailers had stopped
 * complaining:
 *
 *   429 -> we set a cooldown -> the NEXT poll is refused BY US -> that refusal is counted as
 *   a poll error -> five of them trip the circuit breaker -> the breaker's recovery probes
 *   land inside the same cooldown -> more "errors" -> the circuit never closes.
 *
 * The protection was driving the outage. A request that was never sent tells us nothing about
 * the retailer's health.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { isSelfSkip, isRateLimited } = require('../src/utils/stealth-http');

describe('self-skip classification', () => {
  test('our own cooldown is a skip, not a retailer failure', () => {
    assert.ok(isSelfSkip(new Error('Cooling down 594s after 429: https://shop.example/x.json')));
  });

  test('our own budget exhaustion is a skip', () => {
    assert.ok(isSelfSkip(new Error('Rate limited (budget): https://shop.example/x.json')));
  });

  test('a real 429 from the retailer is NOT a skip — it still counts', () => {
    // The retailer actively refused us. That is real signal and must reach the breaker.
    assert.ok(!isSelfSkip(new Error('Rate limited (429): https://shop.example/x.json')));
    assert.ok(isRateLimited(new Error('Rate limited (429): https://shop.example/x.json')));
  });

  test('genuine failures are never skips', () => {
    for (const m of [
      'Blocked after 3 stealth attempts: 403',
      'Stealth: failed after 3 attempts: https://x',
      'Adapter timeout after 120000ms',
      'connect EADDRNOTAVAIL 143.14.236.215:61234',
      'Unexpected token < in JSON',
    ]) {
      assert.ok(!isSelfSkip(new Error(m)), `"${m}" must count as a real error`);
    }
    assert.ok(!isSelfSkip(undefined));
    assert.ok(!isSelfSkip(new Error('')));
  });
});

describe('circuit breaker under self-skips', () => {
  // Mirrors the catch block in scheduler.pollAdapter.
  function simulate(errors, threshold = 5) {
    const circuit = { state: 'closed', errors: 0 };
    for (const err of errors) {
      if (isSelfSkip(err)) continue;               // the fix
      circuit.errors++;
      if (circuit.errors >= threshold && circuit.state === 'closed') circuit.state = 'open';
    }
    return circuit;
  }

  const cooling = () => new Error('Cooling down 300s after 429: https://shop.example/x.json');
  const real429 = () => new Error('Rate limited (429): https://shop.example/x.json');
  const hardFail = () => new Error('Blocked after 3 stealth attempts: 403');

  test('a long cooldown no longer trips the breaker on its own', () => {
    const c = simulate(Array.from({ length: 20 }, cooling));
    assert.strictEqual(c.state, 'closed', 'our own backoff must not open the circuit');
    assert.strictEqual(c.errors, 0);
  });

  test('sustained real 429s still trip it — the signal is not lost', () => {
    const c = simulate(Array.from({ length: 5 }, real429));
    assert.strictEqual(c.state, 'open');
  });

  test('genuine failures still trip it', () => {
    assert.strictEqual(simulate(Array.from({ length: 5 }, hardFail)).state, 'open');
  });

  test('cooldowns interleaved with real errors do not accelerate the trip', () => {
    // 4 real errors + 20 cooldowns must NOT open the circuit; only a 5th real one does.
    const mixed = [real429(), cooling(), real429(), cooling(), cooling(),
      real429(), cooling(), real429(), ...Array.from({ length: 12 }, cooling)];
    assert.strictEqual(simulate(mixed).state, 'closed', '4 real errors is below threshold');
    assert.strictEqual(simulate([...mixed, real429()]).state, 'open', 'the 5th real one trips it');
  });

  test('the old behaviour would have tripped on cooldowns alone', () => {
    // Documents the bug: without the skip check, 5 cooldowns opened the circuit.
    const circuit = { state: 'closed', errors: 0 };
    for (let i = 0; i < 5; i++) {
      circuit.errors++;
      if (circuit.errors >= 5) circuit.state = 'open';
    }
    assert.strictEqual(circuit.state, 'open', 'this is what was happening');
  });
});
