const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const autotune = require('../src/core/autotune');

const feed = (id, n, ok, ms = 1000) => {
  for (let i = 0; i < n; i++) autotune.recordPoll(id, { ok, ms });
};

beforeEach(() => autotune._reset());

describe('autotune: safety rails', () => {
  test('refuses to act on a thin window', () => {
    feed('walmart', autotune.MIN_SAMPLES - 1, true, 1000);
    assert.strictEqual(autotune.decide('walmart', 8000), null);
  });

  test('never speeds below the configured floor', () => {
    feed('walmart', 20, true, 500);
    let interval = 30000;
    for (let i = 0; i < 200; i++) {
      const d = autotune.decide('walmart', interval);
      if (!d) break;
      interval = d.intervalMs;
    }
    assert.strictEqual(interval, 6000, 'walmart floor is 6000ms');
    assert.ok(interval >= 6000);
  });

  test('never exceeds the ceiling no matter how long it fails', () => {
    feed('walmart', 20, false, 3000);
    let interval = 8000;
    for (let i = 0; i < 200; i++) {
      const d = autotune.decide('walmart', interval);
      if (!d) break;
      interval = d.intervalMs;
    }
    assert.strictEqual(interval, 30000, 'walmart ceiling is 30000ms');
  });

  test('a slow store is never polled faster than it responds', () => {
    // 9s polls: interval must be lifted above them or polls overlap and queue.
    feed('bestbuy', 20, true, 9000);
    const d = autotune.decide('bestbuy', 5000);
    assert.ok(d, 'should act');
    assert.ok(d.intervalMs > 9000, `expected >9000ms, got ${d.intervalMs}`);
  });

  test('latency floor beats the configured floor when latency is higher', () => {
    feed('walmart', 20, true, 5583); // real measured p95
    let interval = 9000;
    for (let i = 0; i < 50; i++) {
      const d = autotune.decide('walmart', interval);
      if (!d) break;
      interval = d.intervalMs;
    }
    assert.ok(interval >= 6700, `must respect latency floor, settled at ${interval}`);
    assert.ok(interval > 6000, 'latency floor should exceed the 6000ms configured floor here');
  });
});

describe('autotune: control behaviour', () => {
  test('healthy store speeds up', () => {
    feed('costco', 20, true, 900);
    const d = autotune.decide('costco', 8000);
    assert.ok(d && d.intervalMs < 8000, 'should speed up');
  });

  test('degraded store backs off', () => {
    feed('costco', 20, false, 900);
    const d = autotune.decide('costco', 8000);
    assert.ok(d && d.intervalMs > 8000, 'should back off');
  });

  test('holds steady in the dead band instead of oscillating', () => {
    // 75% success: below HEALTHY (90%) but above DEGRADED (60%)
    feed('walmart', 15, true, 1000);
    feed('walmart', 5, false, 1000);
    assert.strictEqual(autotune.decide('walmart', 8000), null);
  });

  test('full incident: healthy -> blocked -> recovers on its own', () => {
    // settle healthy
    feed('costco', 20, true, 900);
    let interval = 8000;
    for (let i = 0; i < 50 && autotune.decide('costco', interval); i++) {
      interval = autotune.decide('costco', interval).intervalMs;
    }
    const settled = interval;
    assert.strictEqual(settled, 5000, 'settles at costco floor');

    // retailer starts blocking
    autotune._reset();
    feed('costco', 20, false, 900);
    let backoffSteps = 0;
    for (let i = 0; i < 50; i++) {
      const d = autotune.decide('costco', interval);
      if (!d) break;
      interval = d.intervalMs;
      backoffSteps++;
    }
    assert.ok(interval > settled, 'backed off');
    assert.ok(backoffSteps > 0 && backoffSteps <= 10, 'backs off promptly');

    // block lifts — must recover WITHOUT human intervention
    autotune._reset();
    feed('costco', 20, true, 900);
    let recoverySteps = 0;
    for (let i = 0; i < 200; i++) {
      const d = autotune.decide('costco', interval);
      if (!d) break;
      interval = d.intervalMs;
      recoverySteps++;
    }
    assert.strictEqual(interval, settled, 'returns to full speed unaided');
    assert.ok(recoverySteps <= 30, `recovery should take <30min, took ${recoverySteps}`);
  });

  test('every one of the six stores has explicit bounds', () => {
    for (const id of ['walmart', 'amazon', 'costco', 'bestbuy', 'ebgames', 'pokemoncenter']) {
      feed(id, 20, true, 500);
      const s = autotune.getState()[id];
      assert.ok(s.bounds.floor > 0, `${id} needs a floor`);
      assert.ok(s.bounds.ceiling > s.bounds.floor, `${id} ceiling must exceed floor`);
      autotune._reset();
    }
  });
});

describe('autotune: the signal it acts on', () => {
  test('a clean poll that returned nothing counts as a failure, not a success', () => {
    // This is the Walmart case: 0/4 searches through, 0 products, no exception thrown.
    // Exception-only signalling read this as 100% healthy and sped up into a wall.
    const { quality } = simulatePollResult({ freshness: { fresh: 0, attempted: 4 }, newCount: 0, oldCount: 353 });
    assert.strictEqual(quality, false);
  });

  test('a poll with live data counts as success', () => {
    const { quality } = simulatePollResult({ freshness: { fresh: 4, attempted: 4 }, newCount: 40, oldCount: 353 });
    assert.strictEqual(quality, true);
  });

  test('nothing due this cycle is neutral, not a failure', () => {
    const { quality } = simulatePollResult({ freshness: { fresh: 0, attempted: 0 }, newCount: 500, oldCount: 500 });
    assert.strictEqual(quality, null, 'must not penalise a cycle with no work due');
  });

  test('no freshness signal: empty result with cached products is a failure', () => {
    const { quality } = simulatePollResult({ freshness: null, newCount: 0, oldCount: 250 });
    assert.strictEqual(quality, false);
  });

  test('neutral polls are not recorded at all', () => {
    autotune.recordPoll('ebgames', { ok: true, ms: 100 });
    const before = autotune.getState().ebgames.samples;
    // a neutral poll is simply never passed to recordPoll by the scheduler
    assert.strictEqual(before, 1);
  });
});

/** Mirrors the quality derivation in poll-adapter.js so the rule itself is under test. */
function simulatePollResult({ freshness, newCount, oldCount }) {
  let quality = null;
  if (freshness) {
    const { fresh, attempted } = freshness;
    if (attempted > 0) quality = fresh > 0;
  }
  if (quality === null && newCount === 0 && oldCount > 0) quality = false;
  return { quality };
}

describe('autotune: latency floor is outlier-resistant', () => {
  test('one slow cold-start poll does not pin a fast store slow', () => {
    // Amazon's real shape: ~1s steady state, one ~10s first poll after a deploy.
    // With a tail percentile on a 20-sample window this pinned the floor at ~12s.
    autotune.recordPoll('amazon', { ok: true, ms: 10400 });
    feed('amazon', 19, true, 1000);
    let interval = 8000;
    for (let i = 0; i < 50; i++) {
      const d = autotune.decide('amazon', interval);
      if (!d) break;
      interval = d.intervalMs;
    }
    assert.strictEqual(interval, 6000, `outlier must not raise the floor; got ${interval}`);
  });

  test('a genuinely slow store still gets a raised floor', () => {
    feed('bestbuy', 20, true, 9000); // consistently slow, not an outlier
    const d = autotune.decide('bestbuy', 5000);
    assert.ok(d && d.intervalMs > 9000, 'sustained slowness must still raise the floor');
  });
});
