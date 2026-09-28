/**
 * The live trigger feed for auto-checkout.
 *
 * This is the latency path for spending someone's money, so four properties are load-bearing:
 *
 *   PUBLISH MUST NEVER THROW. Its caller is on the delivery path, where an exception skips
 *   markSent() and the alert retries for ever. This repo has already paid for that once
 *   (see the delivery invariants note), so every input shape is tested, including garbage.
 *
 *   A RECONNECT MUST NOT LOSE A TRIGGER. The competitor product broadcasts and dedupes on a
 *   message id, so anything fired while a client was reconnecting is gone — and reconnects
 *   cluster exactly when a drop is happening. The cursor makes that impossible inside the
 *   buffer window.
 *
 *   A CLIENT ALREADY BEHIND MUST NOT BE PARKED. Making it wait would add the latency this file
 *   exists to remove.
 *
 *   STALE TRIGGERS MUST AGE OUT. An auto-buyer acting on an hour-old signal is how someone gets
 *   a surprise charge for an offer that is long gone.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const feed = require('../src/core/checkout-feed');

const TRIGGER = {
  asin: 'B0TESTASIN',
  offerId: 'OLID123',
  price: 86.03,
  title: 'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
  seller: 'Amazon.ca',
  sellerVerified: true,
};

describe('checkout feed', () => {
  beforeEach(() => feed._reset());

  test('publish returns a monotonic sequence', () => {
    assert.strictEqual(feed.publish(TRIGGER), 1);
    assert.strictEqual(feed.publish(TRIGGER), 2);
    assert.strictEqual(feed.publish(TRIGGER), 3);
  });

  test('a waiter parked before the publish is woken with the trigger', async () => {
    const parked = feed.wait(0, 5000);
    feed.publish(TRIGGER);
    const { items, cursor } = await parked;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].asin, 'B0TESTASIN');
    assert.strictEqual(items[0].offerId, 'OLID123');
    assert.strictEqual(cursor, 1);
  });

  test('a client that is already behind is served IMMEDIATELY, not parked', async () => {
    feed.publish(TRIGGER);
    feed.publish({ ...TRIGGER, asin: 'B0SECOND000' });
    // waitMs is huge on purpose: if this parked, the test would time out rather than pass.
    const { items } = await feed.wait(0, 60000);
    assert.deepStrictEqual(items.map(i => i.asin), ['B0TESTASIN', 'B0SECOND000']);
  });

  test('the cursor resumes exactly where the client left off — no loss, no repeat', async () => {
    feed.publish(TRIGGER);                              // seq 1
    const first = await feed.wait(0, 1000);
    assert.strictEqual(first.items.length, 1);

    // The reconnect window: two triggers fire while nobody is listening.
    feed.publish({ ...TRIGGER, asin: 'B0GAP000001' });   // seq 2
    feed.publish({ ...TRIGGER, asin: 'B0GAP000002' });   // seq 3

    const resumed = await feed.wait(first.cursor, 1000);
    assert.deepStrictEqual(resumed.items.map(i => i.asin), ['B0GAP000001', 'B0GAP000002'],
      'a trigger fired during a reconnect must still be delivered');
    assert.strictEqual(resumed.cursor, 3);

    const caughtUp = await feed.wait(resumed.cursor, 1000);
    assert.deepStrictEqual(caughtUp.items, [], 'nothing is delivered twice');
  });

  test('a timeout returns empty and the current cursor, never an error', async () => {
    const { items, cursor } = await feed.wait(0, 1000);
    assert.deepStrictEqual(items, []);
    assert.strictEqual(cursor, 0);
  });

  test('publish NEVER throws, whatever it is handed', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}, { asin: '' }, { asin: '   ' }]) {
      assert.doesNotThrow(() => feed.publish(bad), `threw on ${JSON.stringify(bad)}`);
      assert.strictEqual(feed.publish(bad), null, 'garbage must be refused, not queued');
    }
    // A circular object would break a naive JSON round-trip.
    const circular = { asin: 'B0CIRCULAR' };
    circular.self = circular;
    assert.doesNotThrow(() => feed.publish(circular));
  });

  test('sellerVerified is only ever true when explicitly true', () => {
    // It gates spending money on an unverified seller, so a truthy string must not pass.
    feed.publish({ ...TRIGGER, sellerVerified: 'yes' });
    feed.publish({ ...TRIGGER, sellerVerified: undefined });
    feed.publish({ ...TRIGGER, sellerVerified: true });
    const items = feed._since(0);
    assert.deepStrictEqual(items.map(i => i.sellerVerified), [false, false, true]);
  });

  test('a stale trigger is not delivered', async () => {
    feed.publish(TRIGGER);
    // Age the entry past the cutoff rather than waiting two minutes.
    feed._buffer[0].at = Date.now() - 10 * 60 * 1000;
    const { items } = await feed.wait(0, 1000);
    assert.deepStrictEqual(items, [], 'an auto-buyer must not act on an old signal');
  });

  test('the url defaults to the product page when none is given', () => {
    feed.publish({ asin: 'B0NOURL0000' });
    assert.strictEqual(feed._since(0)[0].url, 'https://www.amazon.ca/dp/B0NOURL0000');
  });

  test('the buffer is bounded — a drop wave cannot grow it without limit', () => {
    for (let i = 0; i < 500; i++) feed.publish({ ...TRIGGER, asin: `B0FLOOD${String(i).padStart(4, '0')}` });
    assert.ok(feed.stats().buffered <= 200, `buffer grew to ${feed.stats().buffered}`);
    assert.strictEqual(feed.stats().cursor, 500, 'the cursor still counts every trigger');
  });

  test('close releases parked requests so shutdown is not blocked', async () => {
    const parked = feed.wait(0, 60000);
    feed.close();
    const { items } = await parked;
    assert.deepStrictEqual(items, []);
  });
});
