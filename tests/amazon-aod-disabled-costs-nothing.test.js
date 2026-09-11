/**
 * A disabled lane must cost NOTHING — not one sleep, not one poll.
 *
 * AOD was replaced by the offers lane and switched off at the LEAF: `_stealthCheckAsin` returns
 * null immediately unless `AMAZON_AOD_STEALTH=1`. The loop around it kept running, and that loop
 * sleeps 1.6-2.2s between every ASIN to pace a 0.45 req/s endpoint budget. With 596 known ASINs
 * that is ~19 minutes of sleeping to accomplish nothing.
 *
 * MEASURED in production 2026-09-11: a poll body of 1,146,747 ms logging
 *   "Amazon: MONITOR — 0/596 ASINs updated (free stealth). 0% success."
 *
 * The sweep runs inside a 6s poll, so the scheduler abandoned the poll at 120s while the sweep kept
 * going, and an abandoned poll returns NO products. Two such blackouts landed in a 26-minute
 * window — 7.7% of the time with zero Amazon detection on every lane, free and paid. Snapshots
 * confirmed 0 of 24 priority ASINs fresh during them.
 *
 * This is the shape to watch for generally: disabling a feature by neutering its innermost call
 * leaves the scaffolding running, and rate-limiting sleeps are the expensive part of scaffolding.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');

const ORIGINAL = process.env.AMAZON_AOD_STEALTH;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AMAZON_AOD_STEALTH;
  else process.env.AMAZON_AOD_STEALTH = ORIGINAL;
});

const makeAdapter = (asinCount) => {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000,
  });
  for (let i = 0; i < asinCount; i++) {
    const asin = `B0SWEEP${String(i).padStart(3, '0')}`;
    a._knownProducts.set(asin, {
      sku: asin, name: 'Pokemon TCG Elite Trainer Box', price: 50, inStock: false,
      category: 'pokemon', lastSeen: 1_757_600_000_000,
    });
  }
  a._aodCooldownUntil = 0;
  a.getFastPollAsins = () => new Set();
  return a;
};

describe('the AOD sweep when AOD is disabled', () => {
  test('returns immediately and touches NOTHING', async () => {
    delete process.env.AMAZON_AOD_STEALTH;
    const a = makeAdapter(50);

    let leafCalls = 0;
    a._stealthCheckAsin = async () => { leafCalls++; return null; };

    const products = {};
    const started = Date.now();
    await a._monitorKnownAsins(products);
    const elapsed = Date.now() - started;

    assert.strictEqual(leafCalls, 0,
      'it must not call the leaf at all — 50 calls would mean 50 pacing sleeps');
    assert.ok(elapsed < 500, `must return at once, took ${elapsed}ms`);
    assert.deepStrictEqual(products, {}, 'and write nothing');
  });

  test('50 ASINs would have cost over a minute of sleeping', async () => {
    // Demonstrates the cost that was being paid every 5 minutes, at 1/12th the real catalogue size.
    // The loop sleeps 1600-2200ms per ASIN, so 596 ASINs is ~19 minutes — the measured figure.
    const PER_ASIN_MIN_MS = 1600;
    const REAL_CATALOGUE = 596;
    const projected = (REAL_CATALOGUE * PER_ASIN_MIN_MS) / 60000;
    assert.ok(projected > 15,
      `the pacing sleep alone projects to ${projected.toFixed(1)} min for the real catalogue, `
      + 'against a 6s poll and a 120s scheduler timeout');
  });

  test('the cursor is not advanced, so nothing is silently skipped on re-enable', async () => {
    delete process.env.AMAZON_AOD_STEALTH;
    const a = makeAdapter(50);
    a._aodCursor = 7;
    a._stealthCheckAsin = async () => null;

    await a._monitorKnownAsins({});
    assert.strictEqual(a._aodCursor, 7,
      'a disabled lane must not consume its own rotation position');
  });

  test('the single-flight guard is left clean', async () => {
    delete process.env.AMAZON_AOD_STEALTH;
    const a = makeAdapter(10);
    a._stealthCheckAsin = async () => null;
    await a._monitorKnownAsins({});
    assert.ok(!a._sweepInFlight, 'returning early must not leave the lane marked busy');
  });

  test('AMAZON_AOD_STEALTH=1 restores the lane with no code change', async () => {
    process.env.AMAZON_AOD_STEALTH = '1';
    const a = makeAdapter(1);           // ONE ASIN, so no pacing sleep is reached
    let leafCalls = 0;
    a._stealthCheckAsin = async () => { leafCalls++; return null; };

    await a._monitorKnownAsins({});
    assert.strictEqual(leafCalls, 1,
      'the gate reads the env at CALL time, so flipping it re-enables the whole lane');
  });
});
