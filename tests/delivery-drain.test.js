/**
 * A deploy must not eat the alerts that are already in flight.
 *
 * `deliver()` enqueues and calls `processQueue()` WITHOUT awaiting it, so it resolves the moment
 * events are queued rather than sent. Shutdown then did `scheduler.stop()` -> `shutdownBot()` ->
 * `process.exit(0)`, destroying the Discord client while the queue could still hold events.
 *
 * That loss is silent and permanent: poll-adapter has already written the new product state, so
 * events.js can never re-fire the restock, and nothing recorded that it happened. Measured queue
 * latency on 2026-09-09 reached 8.5s end to end, and this project deploys on every push to
 * master — three times in one evening while chasing exactly this class of bug.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// delivery.js pulls in core/state, which opens a Redis connection and would hold this test
// process open long after the assertions finish.
const state = require('../src/core/state');
state.getRedis = () => null;

const delivery = require('../src/discord/delivery');

const ev = (type, name) => ({ type, product: { retailerId: 'amazon', sku: 'B0' + name, name, price: 42, inStock: true, url: 'https://x/' + name } });

beforeEach(() => {
  delivery.queue.length = 0;
  delivery.processing = false;
});

describe('drain sends what is queued before the process exits', () => {
  test('a queued alert is delivered rather than dropped', async () => {
    const sent = [];
    delivery.routeEvent = async (event) => { sent.push(event.product.name); };
    delivery.queue.push({ event: ev('RESTOCK', 'ETB'), queuedAt: Date.now() });

    const abandoned = await delivery.drain(5000);
    assert.strictEqual(abandoned, 0, 'nothing should be left behind');
    assert.deepStrictEqual(sent, ['ETB']);
  });

  test('several queued alerts all go out', async () => {
    const sent = [];
    delivery.routeEvent = async (event) => { sent.push(event.product.name); };
    for (const n of ['a', 'b', 'c']) delivery.queue.push({ event: ev('RESTOCK', n), queuedAt: Date.now() });

    assert.strictEqual(await delivery.drain(8000), 0);
    assert.strictEqual(sent.length, 3);
  });

  test('an empty queue drains instantly', async () => {
    const started = Date.now();
    assert.strictEqual(await delivery.drain(5000), 0);
    assert.ok(Date.now() - started < 1000, 'shutdown must not stall on an idle queue');
  });
});

describe('drain is bounded, and says what it abandons', () => {
  test('a hung send does not block shutdown forever', async () => {
    delivery.routeEvent = () => new Promise(() => {});      // never resolves
    delivery.queue.push({ event: ev('RESTOCK', 'stuck'), queuedAt: Date.now() });

    const started = Date.now();
    await delivery.drain(600);
    const took = Date.now() - started;
    assert.ok(took < 4000, `drain must respect its deadline — took ${took}ms`);
  });

  test('an alert that could not be sent is reported, not silently dropped', async () => {
    const logger = require('../src/monitoring/logger');
    const errors = [];
    const original = logger.error;
    logger.error = (msg) => { errors.push(String(msg)); };
    try {
      delivery.routeEvent = () => new Promise(() => {});
      delivery.queue.push({ event: ev('RESTOCK', 'PitchBlackETB'), queuedAt: Date.now() });
      await delivery.drain(400);
      assert.ok(errors.some((e) => /ALERT LOST \(shutdown before send\)/.test(e) && /PitchBlackETB/.test(e)),
        `an abandoned restock must name itself — got ${JSON.stringify(errors)}`);
    } finally { logger.error = original; }
  });

  test('a send that throws does not stop the rest of the drain', async () => {
    const sent = [];
    let n = 0;
    delivery.routeEvent = async (event) => {
      n++;
      if (n === 1) throw new Error('discord 500');
      sent.push(event.product.name);
    };
    for (const name of ['first', 'second']) delivery.queue.push({ event: ev('RESTOCK', name), queuedAt: Date.now() });
    await delivery.drain(5000);
    assert.ok(sent.includes('second'), 'one failure must not strand the queue behind it');
  });
});
