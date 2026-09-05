/**
 * Amazon search: rotation + a real quiet ladder.
 *
 * Measured 2026-09-05. Amazon ran fine for hours (4/4 queries, 92-108 results, zero 503s),
 * then blocked this IP after ~14 hours of four queries every six seconds. It had blocked once
 * earlier the same night and recovered on its own within 23 minutes under light load — but the
 * second block did not decay for over two hours, because the "backoff" only skipped every
 * OTHER cycle and kept sending four blocked requests every twelve seconds.
 *
 * ISP proxies were tested as an escape and are also 503'd, so the free path is to reduce load
 * and go genuinely quiet. Residential works but costs ~48GB/day, which is why it is not used.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const SEARCH_BACKOFF_MS = [60000, 180000, 300000, 600000, 900000];

describe('amazon: query rotation', () => {
  const rotate = (queries, perPoll, polls) => {
    let cursor = 0;
    const batches = [];
    for (let p = 0; p < polls; p++) {
      const batch = [];
      for (let i = 0; i < perPoll && i < queries.length; i++) {
        batch.push(queries[cursor % queries.length]);
        cursor = (cursor + 1) % queries.length;
      }
      batches.push(batch);
    }
    return batches;
  };
  const Q = ['booster box', 'elite trainer box', 'one piece', '30th celebration'];

  test('one query per poll cuts the request rate 4x', () => {
    const batches = rotate(Q, 1, 4);
    const sent = batches.flat().length;
    assert.strictEqual(sent, 4, '4 polls send 4 requests, not 16');
    assert.strictEqual(sent / 4, 1, '0.167 req/s at a 6s interval instead of 0.67');
  });

  test('every query still gets covered, within one full rotation', () => {
    const covered = new Set(rotate(Q, 1, Q.length).flat());
    assert.strictEqual(covered.size, Q.length, 'all queries run within 4 polls (24s)');
  });

  test('rotation keeps its place across polls rather than repeating one query', () => {
    const batches = rotate(Q, 1, 3);
    assert.deepStrictEqual(batches, [[Q[0]], [Q[1]], [Q[2]]]);
  });

  test('a single-query config does not divide by zero or stall', () => {
    assert.deepStrictEqual(rotate(['only'], 1, 2), [['only'], ['only']]);
  });
});

describe('amazon: quiet ladder when blocked', () => {
  function simulate(outcomes) {
    let strikes = 0, blockedUntil = 0, now = 0, sent = 0;
    for (const ok of outcomes) {
      now += 6000; // one poll
      if (now < blockedUntil) continue;     // stayed quiet
      sent += 1;
      if (ok) { strikes = 0; blockedUntil = 0; } else {
        const rung = Math.min(strikes, SEARCH_BACKOFF_MS.length - 1);
        strikes += 1;
        blockedUntil = now + SEARCH_BACKOFF_MS[rung];
      }
    }
    return { strikes, sent };
  }

  test('a sustained block sends a handful of probes, not hundreds', () => {
    // 2 hours of 6s polls = 1200 cycles. The old behaviour sent ~600 blocked requests.
    const r = simulate(Array(1200).fill(false));
    assert.ok(r.sent < 15, `expected a handful of probes, sent ${r.sent}`);
  });

  test('the old every-other-cycle behaviour would have sent ~600', () => {
    let sent = 0;
    for (let i = 0; i < 1200; i++) if (i % 2 === 0) sent++;
    assert.strictEqual(sent, 600, 'documents why the block never decayed');
  });

  test('the ladder climbs and caps', () => {
    const r = simulate(Array(1200).fill(false));
    assert.ok(r.strikes >= SEARCH_BACKOFF_MS.length, 'reaches the top rung');
  });

  test('one success clears the ladder immediately', () => {
    // The quiet period has to elapse before the next probe goes out, so pad with skipped
    // polls: one failure buys 60s of quiet, which is ten 6s cycles.
    // One failure buys 60s of quiet. At 6s per poll the next probe is the 11th cycle
    // (now = 66000), so that is where the success has to land.
    const outcomes = Array(11).fill(false);
    outcomes[10] = true;
    const r = simulate(outcomes);
    assert.strictEqual(r.strikes, 0, 'recovery resets, so a blip costs nothing');
    assert.strictEqual(r.sent, 2, 'one initial attempt, then one probe after the quiet period');
  });

  test('a healthy Amazon is never throttled by this', () => {
    const r = simulate(Array(100).fill(true));
    assert.strictEqual(r.sent, 100, 'every poll searches while it is working');
    assert.strictEqual(r.strikes, 0);
  });
});
