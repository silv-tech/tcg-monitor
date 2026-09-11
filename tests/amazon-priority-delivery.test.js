/**
 * Priority watchlist — delivery-side safety.
 *
 * Stamping _watchlist deliberately removes every brake (limiter mute-exemption, queue bypass,
 * 3-channel routing, 45s restock dedup). Two things must hold so that does not turn a flapping buy
 * box into the ZardoCards flood, or a repurposed ASIN into a silent miss:
 *   1. FLOOD CAP — SENT restock alerts per watchlist ASIN are bounded over a rolling hour; over the
 *      cap the alert is suppressed but logged, and marked sent so it cannot retry-loop.
 *   2. GAP A ESCALATE — a wrong-identity verdict on a watchlist ASIN escalates to admin instead of
 *      being silently dropped + denylisted (which is what happens for a non-watchlist ASIN).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => ({ get: async () => null, set: async () => {} });
const config = require('../src/config');

const delivery = require('../src/discord/delivery');

const FLOOD_MAX = Number(process.env.WATCHLIST_FLOOD_MAX) || 8;

// The delivery module is a singleton; stubbing its methods leaks across tests. Capture the real
// ones and restore after every test so, e.g., the flood-cap tests stubbing routeEvent cannot break
// the GAP A tests that need the real routeEvent.
const REAL = {
  routeEvent: delivery.routeEvent,
  enrichEvent: delivery.enrichEvent,
  _escalateWatchlistDivergence: delivery._escalateWatchlistDivergence,
  sendToChannel: delivery.sendToChannel,
  resolvePaidChannel: delivery.resolvePaidChannel,
  processQueue: delivery.processQueue,
  denyIdentity: state.denyIdentity,
};
afterEach(() => {
  delivery.routeEvent = REAL.routeEvent;
  delivery.enrichEvent = REAL.enrichEvent;
  delivery._escalateWatchlistDivergence = REAL._escalateWatchlistDivergence;
  delivery.sendToChannel = REAL.sendToChannel;
  delivery.resolvePaidChannel = REAL.resolvePaidChannel;
  delivery.processQueue = REAL.processQueue;
  state.denyIdentity = REAL.denyIdentity;
});

function wlRestock(sku) {
  return { type: 'RESTOCK', product: { retailerId: 'amazon', sku, name: `Pokémon TCG ${sku}`, price: 199, inStock: true, isTCG: true, _watchlist: true, url: `https://www.amazon.ca/dp/${sku}` } };
}

beforeEach(() => {
  delivery.queue.length = 0;
  delivery.processing = false;
  delivery._wlRestockHistory = new Map();
});

describe('flood cap: bounds SENT restocks per watchlist ASIN over a rolling hour', () => {
  // Stub processQueue to a no-op so the non-watchlist queue is inspectable (deliver() otherwise
  // drains it asynchronously). Watchlist events bypass the queue, so this does not affect them.
  beforeEach(() => { delivery.processQueue = () => {}; });

  test('suppresses the restock once the ASIN is at the cap (routeEvent not called)', async () => {
    const sent = [];
    delivery.routeEvent = async (e) => { sent.push(e.product.sku); };
    delivery._wlRestockHistory.set('B0FLAP', Array.from({ length: FLOOD_MAX }, () => Date.now()));
    await delivery.deliver([wlRestock('B0FLAP')], { skipDedup: true });
    assert.ok(!sent.includes('B0FLAP'), 'the over-cap restock is suppressed, not routed');
  });

  test('sends and records when under the cap', async () => {
    const sent = [];
    delivery.routeEvent = async (e) => { sent.push(e.product.sku); };
    delivery._wlRestockHistory.set('B0OK', [Date.now()]); // 1 < cap
    await delivery.deliver([wlRestock('B0OK')], { skipDedup: true });
    assert.deepStrictEqual(sent, ['B0OK'], 'under the cap it routes normally');
    assert.strictEqual(delivery._wlRestockHistory.get('B0OK').length, 2, 'the send is recorded (rolling window grows)');
  });

  test('rolling window: timestamps older than an hour do not count toward the cap', async () => {
    const sent = [];
    delivery.routeEvent = async (e) => { sent.push(e.product.sku); };
    const old = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    delivery._wlRestockHistory.set('B0OLD', Array.from({ length: FLOOD_MAX }, () => old));
    await delivery.deliver([wlRestock('B0OLD')], { skipDedup: true });
    assert.deepStrictEqual(sent, ['B0OLD'], 'stale timestamps are pruned, so the ASIN is under the cap again');
    assert.strictEqual(delivery._wlRestockHistory.get('B0OLD').length, 1, 'only the fresh send remains after pruning');
  });

  test('a non-watchlist product is not affected by the cap', async () => {
    const sent = [];
    delivery.routeEvent = async (e) => { sent.push(e.product.sku); };
    const e = wlRestock('B0NORMAL');
    e.product._watchlist = false;
    // even with a full history for that sku, a non-watchlist event is queued (not gated here)
    delivery._wlRestockHistory.set('B0NORMAL', Array.from({ length: FLOOD_MAX }, () => Date.now()));
    await delivery.deliver([e], { skipDedup: true });
    assert.strictEqual(delivery.queue.length, 1, 'non-watchlist restock goes to the normal queue, uncapped by this backstop');
  });
});

describe('routing: Amazon priority alerts go to the Amazon channel only', () => {
  test('a watchlist Amazon RESTOCK sends to the Amazon paid channel (with the WATCHLIST header), not a separate watchlist channel', async () => {
    delivery.enrichEvent = async () => {};
    delivery.resolvePaidChannel = () => 'AMAZON_CH';
    const sends = [];
    delivery.sendToChannel = async (ch, embed, components, content) => { sends.push({ ch, content }); };
    const event = wlRestock('B0ROUTE'); // retailerId 'amazon', _watchlist true
    await delivery.routeEvent(event, Date.now());
    assert.strictEqual(sends.length, 1, 'exactly one send — the Amazon channel, no separate watchlist-channel copy');
    assert.strictEqual(sends[0].ch, 'AMAZON_CH');
    assert.match(sends[0].content || '', /WATCHLIST/, 'still carries the WATCHLIST header so it stands out');
  });
});

describe('GAP A: wrong-identity on a watchlist ASIN escalates instead of silent-dropping', () => {
  let denied;
  beforeEach(() => {
    denied = [];
    state.denyIdentity = async (retailer, sku) => { denied.push(sku); };
    delivery.enrichEvent = async () => {}; // leave the preset event._identity intact
  });

  test('watchlist ASIN: escalated to admin, NOT denylisted', async () => {
    let escalated = null;
    delivery._escalateWatchlistDivergence = async (e) => { escalated = e.product.sku; };
    const event = wlRestock('B0DIVERGE');
    event._identity = { verdict: 'wrong-identity', title: 'PopSockets Phone Grip', reason: 'live title mismatch' };
    await delivery.routeEvent(event, Date.now());
    assert.strictEqual(escalated, 'B0DIVERGE', 'a divergent priority ASIN is escalated to a human');
    assert.deepStrictEqual(denied, [], 'and is NOT denylisted (it stays tracked)');
  });

  test('non-watchlist ASIN: still suppressed + denylisted (unchanged behavior)', async () => {
    let escalated = null;
    delivery._escalateWatchlistDivergence = async (e) => { escalated = e.product.sku; };
    const event = wlRestock('B0BADID');
    event.product._watchlist = false;
    event._identity = { verdict: 'wrong-identity', title: 'PopSockets Phone Grip', reason: 'live title mismatch' };
    await delivery.routeEvent(event, Date.now());
    assert.strictEqual(escalated, null, 'no escalation for a non-watchlist ASIN');
    assert.deepStrictEqual(denied, ['B0BADID'], 'a non-watchlist divergence is still denylisted');
  });

  test('_escalateWatchlistDivergence builds a valid embed and never throws', async () => {
    config.discord = config.discord || {};
    const prevAdmin = config.discord.adminChannelId;
    config.discord.adminChannelId = 'test-admin-channel';
    const calls = [];
    delivery.sendToChannel = async (ch, embed) => { calls.push({ ch, embed }); };
    const event = wlRestock('B0EMBED');
    event._identity = { verdict: 'wrong-identity', title: 'PopSockets Phone Grip', reason: 'live title mismatch' };
    await assert.doesNotReject(delivery._escalateWatchlistDivergence(event));
    assert.strictEqual(calls.length, 1, 'escalation was sent');
    assert.ok(calls[0].embed && calls[0].embed.data && /DIVERGENCE/.test(calls[0].embed.data.title), 'a valid embed with a title was built');
    config.discord.adminChannelId = prevAdmin;
  });

  test('_escalateWatchlistDivergence with no admin channel logs and does not throw', async () => {
    config.discord = config.discord || {};
    const prevAdmin = config.discord.adminChannelId;
    config.discord.adminChannelId = undefined;
    const event = wlRestock('B0NOCH');
    event._identity = { verdict: 'wrong-identity', title: 'x', reason: 'y' };
    await assert.doesNotReject(delivery._escalateWatchlistDivergence(event));
    config.discord.adminChannelId = prevAdmin;
  });
});
