/**
 * Operational notices need their own route, and they must never be able to ping anyone.
 *
 * Members sit in these channels waiting on drops, so planned work has to be announced before it
 * starts and closed out when it finishes. Every other endpoint that can reach a channel attaches a
 * product embed (sample-alert, test-alert) or posts a fixed guide (post-guide) — all of which read
 * as an alert rather than an announcement.
 *
 * The mention guard is the part that matters most. A maintenance notice written with "@everyone" in
 * the body, or posted to a channel where a role name happens to appear, must not notify the server.
 * `allowedMentions: { parse: [] }` makes that structurally impossible rather than relying on how the
 * text was written.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;

const bot = require('../src/discord/bot');
const router = require('../src/admin/routes');

// Find the layer the router registered for POST /announce and invoke its handler directly. A live
// HTTP server would keep the process alive under `node --test`.
function handlerFor(method, path) {
  const layer = (router.stack || []).find(
    (l) => l.route && l.route.path === path && l.route.methods && l.route.methods[method],
  );
  assert.ok(layer, `no ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const realGetClient = bot.getClient;
let sent;

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

beforeEach(() => {
  sent = [];
  bot.getClient = () => ({
    channels: { fetch: async (id) => ({ id, send: async (payload) => { sent.push({ id, payload }); } }) },
  });
});
afterEach(() => { bot.getClient = realGetClient; });

const post = async (body) => {
  const r = res();
  await handlerFor('post', '/announce')({ body }, r);
  return r;
};

describe('an announcement posts a clean embed', () => {
  test('it sends an embed with the given title and body', async () => {
    const r = await post({ channelId: 'C1', title: 'Scheduled maintenance', body: 'Back shortly.' });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(sent.length, 1);
    const e = sent[0].payload.embeds[0].data;
    assert.strictEqual(e.title, 'Scheduled maintenance');
    assert.strictEqual(e.description, 'Back shortly.');
    assert.ok(e.timestamp, 'a notice must be timestamped');
    assert.match(e.footer.text, /Operations/);
  });

  test('no product embed or components are attached', async () => {
    await post({ channelId: 'C1', title: 'T', body: 'B' });
    const p = sent[0].payload;
    assert.strictEqual(p.embeds.length, 1, 'exactly one embed — this is not an alert');
    assert.strictEqual(p.components, undefined, 'no checkout buttons on an operational notice');
  });

  test('each kind gets its own colour', async () => {
    const seen = {};
    for (const kind of ['notice', 'maintenance', 'resolved']) {
      sent = [];
      const r = await post({ channelId: 'C1', title: 'T', body: 'B', kind });
      assert.strictEqual(r.statusCode, 200, kind);
      seen[kind] = sent[0].payload.embeds[0].data.color;
    }
    assert.strictEqual(new Set(Object.values(seen)).size, 3, 'maintenance and resolved must look different');
  });
});

describe('it can never ping the server', () => {
  test('allowedMentions suppresses every mention type', async () => {
    await post({ channelId: 'C1', title: 'T', body: 'B' });
    assert.deepStrictEqual(sent[0].payload.allowedMentions, { parse: [] });
  });

  test('an @everyone written into the body still cannot notify', async () => {
    await post({ channelId: 'C1', title: 'Heads up @everyone', body: 'ping @here <@&123456789>' });
    // The text is preserved — it just cannot resolve to a notification.
    assert.match(sent[0].payload.embeds[0].data.description, /@here/);
    assert.deepStrictEqual(sent[0].payload.allowedMentions, { parse: [] },
      'the guard must be structural, not dependent on how the body was written');
  });
});

describe('bad input is refused rather than half-posted', () => {
  for (const body of [
    {},
    { channelId: 'C1' },
    { channelId: 'C1', title: 'T' },
    { title: 'T', body: 'B' },
  ]) {
    test(`rejects ${JSON.stringify(body)}`, async () => {
      const r = await post(body);
      assert.strictEqual(r.statusCode, 400);
      assert.strictEqual(sent.length, 0, 'nothing may be posted on a rejected request');
    });
  }

  test('an unknown kind is refused, not silently defaulted', async () => {
    const r = await post({ channelId: 'C1', title: 'T', body: 'B', kind: 'emergency' });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(sent.length, 0);
  });

  test('a missing body object does not throw', async () => {
    const r = res();
    await handlerFor('post', '/announce')({}, r);
    assert.strictEqual(r.statusCode, 400);
  });
});

describe('oversized input is clamped to Discord limits', () => {
  test('title and description are truncated rather than rejected by Discord', async () => {
    await post({ channelId: 'C1', title: 'T'.repeat(400), body: 'B'.repeat(5000) });
    const e = sent[0].payload.embeds[0].data;
    assert.strictEqual(e.title.length, 256);
    assert.strictEqual(e.description.length, 4000);
  });
});
