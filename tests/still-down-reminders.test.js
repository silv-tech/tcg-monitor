/**
 * A retailer used to be reported exactly once per outage and then never mentioned again.
 *
 * Costco went DETECTION DOWN at 19:44 on 2026-09-06. At 20:41 — 57 minutes later — it was
 * still down and #admin-alerts had said nothing since. The one thing you need from a monitor
 * is to keep telling you a store is broken until you fix it.
 *
 * These mirror the ladder in alerts.js. The tension is real in both directions: silence is
 * how an outage runs for an hour unnoticed, and a fixed short interval turns a long outage
 * into a wall of identical messages nobody reads.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const REMINDER_LADDER_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
const REMINDER_MAX_MS = 60 * 60 * 1000;
const MIN = 60 * 1000;

// Mirrors the due-check in checkAndAlert.
function isDue(state, now) {
  const wait = REMINDER_LADDER_MS[state.reminders] ?? REMINDER_MAX_MS;
  return now - state.lastAt >= wait;
}

function humanDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

describe('still-down reminders: an outage keeps being reported', () => {
  test('the Costco outage would now be chased, not left silent', () => {
    // Broke at t=0, first alert sent immediately.
    const st = { firstAt: 0, lastAt: 0, reminders: 0 };
    const fired = [];
    // The health loop runs every 2 minutes; walk 60 minutes of it.
    for (let t = 2 * MIN; t <= 60 * MIN; t += 2 * MIN) {
      if (isDue(st, t)) { fired.push(t / MIN); st.reminders++; st.lastAt = t; }
    }
    assert.deepStrictEqual(fired, [6, 22, 52], 'reminders at ~5, ~15 then ~30 min apart');
    assert.ok(fired.length >= 3, 'the 57-minute silence cannot happen again');
  });

  test('no reminder before the first rung', () => {
    const st = { firstAt: 0, lastAt: 0, reminders: 0 };
    assert.strictEqual(isDue(st, 4 * MIN), false);
    assert.strictEqual(isDue(st, 5 * MIN), true);
  });

  test('the gap widens instead of repeating every 5 minutes', () => {
    const st = { firstAt: 0, lastAt: 0, reminders: 0 };
    const gaps = [];
    let last = 0;
    for (let t = MIN; t <= 6 * 60 * MIN; t += MIN) {
      if (isDue(st, t)) { gaps.push((t - last) / MIN); last = t; st.reminders++; st.lastAt = t; }
    }
    assert.deepStrictEqual(gaps.slice(0, 3), [5, 15, 30]);
    for (const g of gaps.slice(3)) assert.strictEqual(g, 60, 'then settles at hourly');
  });

  test('a long outage does not flood the channel', () => {
    const st = { firstAt: 0, lastAt: 0, reminders: 0 };
    let count = 0;
    for (let t = MIN; t <= 24 * 60 * MIN; t += MIN) {
      if (isDue(st, t)) { count++; st.reminders++; st.lastAt = t; }
    }
    // 3 ladder rungs plus roughly hourly for the rest of the day.
    assert.ok(count <= 27, 'a full day of downtime stays readable, got ' + count);
    assert.ok(count >= 20, 'but it never goes quiet either, got ' + count);
  });
});

describe('still-down reminders: state handling', () => {
  test('a retailer alerted for the first time is not immediately reminded', () => {
    // firstAt === lastAt === now, so nothing is due on the same pass.
    const st = { firstAt: 1000, lastAt: 1000, reminders: 0 };
    assert.strictEqual(isDue(st, 1000), false);
  });

  test('recovery clears the state, so a later outage starts the ladder again', () => {
    const alerted = new Map([['costco', { firstAt: 0, lastAt: 0, reminders: 3 }]]);
    alerted.delete('costco');
    assert.strictEqual(alerted.get('costco'), undefined);
    const fresh = { firstAt: 0, lastAt: 0, reminders: 0 };
    assert.strictEqual(isDue(fresh, 5 * MIN), true, 'a new outage is chased from the first rung');
  });
});

describe('still-down reminders: duration wording', () => {
  test('reads naturally at the scales that matter', () => {
    assert.strictEqual(humanDuration(5 * MIN), '5 min');
    assert.strictEqual(humanDuration(57 * MIN), '57 min');
    assert.strictEqual(humanDuration(60 * MIN), '1h');
    assert.strictEqual(humanDuration(95 * MIN), '1h 35m');
    assert.strictEqual(humanDuration(24 * 60 * MIN), '24h');
  });
});
