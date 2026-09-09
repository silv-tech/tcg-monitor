/**
 * Reporting in-store-only London Drugs finds.
 *
 * The one rule that matters: these go to the ADMIN channel and nowhere else. A hidden code has
 * no name from any endpoint, and hidden does not mean Pokemon — a NETGEAR switch and a bag of
 * Peeps came out of the same scan window as three real 30th Celebration SKUs. A person confirms
 * from the box art before anything reaches paying members.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const state = require('../src/core/state');
const { reportLdCandidates, QUEUE_KEY } = require('../src/monitoring/ld-candidates');

config.discord = { ...config.discord, adminChannelId: 'admin-chan', adminUserId: 'u1' };

let queue;
let sentTo;
let payloads;

function fakeRedis() {
  return { async lpop(k) { return k === QUEUE_KEY ? (queue.shift() || null) : null; } };
}

function client({ fail = false } = {}) {
  return {
    channels: {
      fetch: async (id) => {
        sentTo.push(id);
        return { send: async (p) => { if (fail) throw new Error('discord 500'); payloads.push(p); } };
      },
    },
  };
}

const candidate = (over = {}) => JSON.stringify({
  code: 'L3445613', stores: 46, units: 2628,
  image: 'https://cdn-tp2.mozu.com/28945-m4/cms/files/L3445613.jpg',
  top: [{ name: 'Royal Oak Centre', city: 'Calgary', qty: 72 }, { name: 'North Town Centre', city: 'Edmonton', qty: 48 }],
  ...over,
});

beforeEach(() => {
  queue = [];
  sentTo = [];
  payloads = [];
  state.getRedis = () => fakeRedis();
});

describe('a landed in-store drop is reported to admin', () => {
  test('it goes to the admin channel, not a client channel', async () => {
    queue = [candidate()];
    await reportLdCandidates(client());
    assert.deepStrictEqual(sentTo, ['admin-chan'],
      'an unnamed product must never reach the client channel unconfirmed');
  });

  test('the embed carries the stock, the code and the box art', async () => {
    queue = [candidate()];
    await reportLdCandidates(client());
    const e = payloads[0].embeds[0].data;
    assert.match(e.title, /IN-STORE/);
    assert.ok(e.fields.some((f) => /2628 units across 46/.test(f.value)));
    assert.ok(e.fields.some((f) => f.value === 'L3445613'));
    assert.match(e.image.url, /L3445613\.jpg$/);
    assert.ok(!e.image.url.includes('londondrugs.com'), 'the CDN is what makes the image reachable at all');
  });

  test('the top stores are named so the alert is actionable', async () => {
    queue = [candidate()];
    await reportLdCandidates(client());
    const f = payloads[0].embeds[0].data.fields.find((x) => x.name === 'Top stores');
    assert.match(f.value, /Royal Oak Centre — 72/);
    assert.match(f.value, /North Town Centre — 48/);
  });

  test('several queued finds are all reported', async () => {
    queue = [candidate(), candidate({ code: 'L3445579' }), candidate({ code: 'L3445571' })];
    assert.strictEqual(await reportLdCandidates(client()), 3);
  });
});

describe('it never breaks the sweep it runs inside', () => {
  test('an empty queue is a no-op', async () => {
    assert.strictEqual(await reportLdCandidates(client()), 0);
    assert.strictEqual(payloads.length, 0);
  });

  test('no redis is a no-op rather than a throw', async () => {
    state.getRedis = () => null;
    queue = [candidate()];
    assert.strictEqual(await reportLdCandidates(client()), 0);
  });

  test('a corrupt entry is skipped, not retried forever', async () => {
    queue = ['not json', candidate()];
    assert.strictEqual(await reportLdCandidates(client()), 1);
  });

  test('a Discord failure leaves the remainder queued rather than dropping drops', async () => {
    queue = [candidate(), candidate({ code: 'L3445579' })];
    await reportLdCandidates(client({ fail: true }));
    assert.strictEqual(queue.length, 1, 'the unsent candidate must survive to the next sweep');
  });

  test('a backlog is bounded so the health sweep is not stalled', async () => {
    queue = Array.from({ length: 20 }, (_, i) => candidate({ code: `L344560${i}` }));
    const sent = await reportLdCandidates(client());
    assert.ok(sent <= 5, `bounded per sweep, sent ${sent}`);
    assert.ok(queue.length >= 15, 'the rest waits its turn');
  });

  test('with no admin channel configured it does nothing', async () => {
    const saved = config.discord.adminChannelId;
    config.discord = { ...config.discord, adminChannelId: null };
    queue = [candidate()];
    assert.strictEqual(await reportLdCandidates(client()), 0);
    config.discord = { ...config.discord, adminChannelId: saved };
  });
});
