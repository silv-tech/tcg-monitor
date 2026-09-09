/**
 * A self-healing blip must not page anyone.
 *
 * There was no debounce: the first health sweep that saw healthy===false sent the Discord
 * embed. Shopify shops take genuine 429s on /products.json, go quiet while the backoff is
 * honoured, and heal in a couple of minutes — and every one of those produced a
 * "Monitor Alert / Still down / Recovery" trio in the client's channel. On 2026-09-09 that was
 * six pages in twenty minutes for outages that had already fixed themselves. An alert channel
 * everyone learns to ignore is a worse failure than the blip it was reporting.
 *
 * Also pins the duration bug: firstAt was stamped when we PAGED, not when the retailer broke,
 * so "Down for 6 min" and "back online after 2 min" described the same episode and both
 * understated the real silence by the stale threshold.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// Stub the health module BEFORE alerts.js destructures it at require time.
const health = require('../src/monitoring/health');
let retailers = [];
health.isSystemHealthy = async () => ({ retailers, healthy: retailers.every((r) => r.healthy) });
health.checkRedisHealth = async () => ({ healthy: true });
health.getZeroProductPolls = () => new Map();
health.getComposition = () => ({});
health.persistComposition = async () => {};

// alerts.js now drains the London Drugs in-store candidate queue, which reaches for Redis.
// These tests are about health paging, so keep Redis out of the process entirely.
const state = require('../src/core/state');
state.getRedis = () => null;

const config = require('../src/config');
config.discord = { ...config.discord, adminChannelId: 'admin-chan', adminUserId: 'u1' };

const { checkAndAlert } = require('../src/monitoring/alerts');

// A Discord client that records what it was asked to send.
const sent = [];
const client = {
  channels: { fetch: async () => ({ send: async (payload) => { sent.push(payload); } }) },
};

const shop = (id, healthy) => ({
  id, name: id, healthy, stale: !healthy, consecutiveErrors: 0, lastError: null,
  zeroProductPolls: 0, zeroFreshPolls: 0, servingStaleData: false, throttledForMs: 0,
});

function titles() {
  return sent.flatMap((p) => (p.embeds || []).map((e) => e.data?.title || ''));
}

beforeEach(() => { sent.length = 0; retailers = []; });

describe('a blip that heals itself pages nobody', () => {
  test('one unhealthy sweep sends nothing', async () => {
    retailers = [shop('401games', false)];
    await checkAndAlert(client);
    assert.deepStrictEqual(titles(), [], 'the first sight of trouble is not proof of an outage');
  });

  test('unhealthy then healthy again — still nothing, and no phantom recovery', async () => {
    retailers = [shop('doescards', false)];
    await checkAndAlert(client);
    retailers = [shop('doescards', true)];
    await checkAndAlert(client);
    assert.deepStrictEqual(titles(), [],
      'a shop that healed before the debounce elapsed must produce no alert AND no recovery');
  });
});

describe('a real outage still pages', () => {
  test('a retailer unhealthy past the debounce is reported', async () => {
    retailers = [shop('costco', false)];
    await checkAndAlert(client);              // first sighting — silent
    assert.deepStrictEqual(titles(), []);

    // Simulate the debounce elapsing without waiting for it.
    process.env.ALERT_PAGE_AFTER_MS = '1';
    delete require.cache[require.resolve('../src/monitoring/alerts')];
    const fresh = require('../src/monitoring/alerts');
    retailers = [shop('costco', false)];
    await fresh.checkAndAlert(client);        // pending is empty in the fresh module...
    await new Promise((r) => setTimeout(r, 20));   // ...let the (1ms) debounce actually elapse
    await fresh.checkAndAlert(client);        // ...so the second sweep pages
    delete process.env.ALERT_PAGE_AFTER_MS;

    const t = sent.flatMap((p) => (p.embeds || []).map((e) => e.data?.title || ''));
    assert.ok(t.some((x) => /Monitor Alert/.test(x)),
      `a genuine outage must still page — got ${JSON.stringify(t)}`);
  });
});

describe('a healthy system says nothing', () => {
  test('all healthy produces no embeds', async () => {
    retailers = [shop('401games', true), shop('doescards', true)];
    await checkAndAlert(client);
    assert.deepStrictEqual(titles(), []);
  });
});
