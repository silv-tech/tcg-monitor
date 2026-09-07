/**
 * A retailer we are deliberately not polling is not a retailer that is down.
 *
 * The rate-limit backoff ladder runs 30s, 60s, 2m, 5m, 15m. The stale threshold floors at 5
 * minutes. So any shop reaching strike four was guaranteed to be declared stale — the monitor
 * was alerting on its own backoff.
 *
 * Over eight hours of the admin channel that was 33 alerts for Infinity Cards and 18 for
 * Hobbiesville, each one a Monitor Alert, a Still-down reminder and a Recovery, for shops that
 * were never actually broken.
 *
 * The correction must not become a mute, so both directions are asserted: throttling is
 * forgiven, a real outage still alerts.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MIN_STALE_MS = 5 * 60 * 1000;
const MAX_STALE_MS = 30 * 60 * 1000;

// Mirrors the staleness rule in health.js.
function isStale({ intervalMs = 16000, sinceLastCheckMs, cooldownMs = 0 }) {
  const base = Math.max(MIN_STALE_MS, Math.min(intervalMs * 3, MAX_STALE_MS));
  return sinceLastCheckMs > base + cooldownMs;
}

const MIN = 60000;

describe('deliberate backoff is not an outage', () => {
  test('a shop quiet inside a 15-minute cooldown is not stale', () => {
    assert.strictEqual(isStale({ sinceLastCheckMs: 12 * MIN, cooldownMs: 15 * MIN }), false);
  });

  test('the strike-4 case that generated the alerts is now silent', () => {
    // 5-minute cooldown, 6 minutes since the last successful check — this is the exact
    // "Down for 6 min" shape seen in the admin channel.
    assert.strictEqual(isStale({ sinceLastCheckMs: 6 * MIN, cooldownMs: 5 * MIN }), false);
  });

  test('without a cooldown the old threshold is unchanged', () => {
    assert.strictEqual(isStale({ sinceLastCheckMs: 6 * MIN, cooldownMs: 0 }), true);
    assert.strictEqual(isStale({ sinceLastCheckMs: 4 * MIN, cooldownMs: 0 }), false);
  });
});

describe('it is a grace period, not a mute', () => {
  test('a genuinely unreachable shop still alerts once silence outlives the cooldown', () => {
    // lastCheck only advances on a SUCCESSFUL poll, so silence keeps growing while the
    // cooldown is capped at 15 minutes.
    assert.strictEqual(isStale({ sinceLastCheckMs: 21 * MIN, cooldownMs: 15 * MIN }), true);
  });

  test('the grace can never exceed the ladder cap', () => {
    const { BACKOFF_LADDER_MS } = require('../src/utils/stealth-http');
    assert.strictEqual(Math.max(...BACKOFF_LADDER_MS), 15 * MIN,
      'if the ladder grows, the silence window grows with it — keep them in step');
  });

  test('a slow-polling retailer keeps its own larger threshold', () => {
    // 5-minute interval → 15-minute base, unchanged by this rule when nothing is throttled.
    assert.strictEqual(isStale({ intervalMs: 5 * MIN, sinceLastCheckMs: 14 * MIN }), false);
    assert.strictEqual(isStale({ intervalMs: 5 * MIN, sinceLastCheckMs: 16 * MIN }), true);
  });
});

describe('the cooldown accessor health.js relies on', () => {
  const { cooldownRemaining, setCooldown, _resetCooldowns } = require('../src/utils/stealth-http');

  test('reports remaining time for a throttled host and zero otherwise', () => {
    _resetCooldowns();
    assert.strictEqual(cooldownRemaining('https://infinitycards.ca/products.json'), 0);
    setCooldown('https://infinitycards.ca/products.json');
    assert.ok(cooldownRemaining('https://infinitycards.ca/products.json') > 0,
      'health.js extends the stale threshold by exactly this value');
    assert.strictEqual(cooldownRemaining('https://someothershop.ca/products.json'), 0,
      'one shop being throttled must not excuse another');
    _resetCooldowns();
  });
});
