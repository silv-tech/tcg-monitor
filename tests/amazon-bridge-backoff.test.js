/**
 * A challenge backoff must outlive the page that earned it.
 *
 * THE INCIDENT THIS PINS — 2026-09-28. The bridge's first live run fetched amazon.ca every ~5.0s
 * and Amazon served a captcha at 14:22:46. The extension logged
 * `blocked (captcha (3781b)) — pausing 60min` and everything looked correct. It was not: the
 * pause was an in-memory `await sleep()` inside content.js, so when the extension was reloaded to
 * pick up new settings, the sleeping page was destroyed and a fresh one started a cycle
 * immediately. The bridge was fetching again SEVEN minutes after the challenge instead of sixty.
 *
 * Going straight back at a site that just challenged you is how a soft challenge earns a hard
 * one, and the failure is invisible — the log still shows the reassuring "pausing 60min" line
 * that the reload then threw away.
 *
 * So the deadline is now OWNED BY THE WORKER and written to chrome.storage.local, and the worker
 * refuses to hand out work until it passes. Content scripts may die freely; the pause does not.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../amazon-extension/background.js'), 'utf8');

/** A chrome stand-in with just the surface background.js touches. */
function makeChrome(store = {}) {
  const listeners = [];
  return {
    listeners,
    storage: {
      local: {
        async get(defaults) {
          const out = {};
          for (const k of Object.keys(defaults)) out[k] = k in store ? store[k] : defaults[k];
          return out;
        },
        async set(obj) { Object.assign(store, obj); },
      },
      onChanged: { addListener() {} },
    },
    store,
    runtime: {
      onMessage: { addListener: fn => listeners.push(fn) },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      lastError: null,
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onRemoved: { addListener() {} } },
    action: { onClicked: { addListener() {} } },
  };
}

/** Load background.js in a sandbox and return its amz-work responder. */
function loadWorker(store) {
  const chrome = makeChrome(store);
  const ctx = {
    chrome, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    console, setTimeout, clearTimeout, URL,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'background.js' });
  return { chrome, ask: msg => new Promise(res => {
    for (const fn of chrome.listeners) if (fn(msg, {}, res)) return;
    res(undefined);
  }) };
}

const CONFIGURED = {
  enabled: true, baseUrl: 'https://example.invalid', apiKey: 'k',
  batchSize: 8, concurrency: 1, gapMs: 3500, cycleDelaySec: 60,
};

describe('a persisted challenge backoff', () => {
  test('a LIVE deadline refuses work, however many times the page restarts', async () => {
    const store = { ...CONFIGURED, blockedUntil: Date.now() + 45 * 60 * 1000 };
    const { ask } = loadWorker(store);
    // Three independent "fresh content script" asks, as a reload or eviction would produce.
    for (let i = 0; i < 3; i++) {
      const r = await ask({ type: 'amz-work' });
      // Length, not deepStrictEqual: the array is built in the vm realm and cross-realm
      // deepStrictEqual against a host [] fails on the prototype, not the contents.
      assert.strictEqual(r.items.length, 0, 'no work may be handed out while blocked');
      assert.ok(r.blockedFor > 0, 'and the page must be told how long is left');
    }
  });

  test('an EXPIRED deadline does not block forever', async () => {
    const store = { ...CONFIGURED, blockedUntil: Date.now() - 1000 };
    const { ask } = loadWorker(store);
    const r = await ask({ type: 'amz-work' });
    assert.ok(!r.blockedFor, 'a passed deadline must release the lane');
  });

  test('a block NOTE writes the deadline, so it survives the page that reported it', async () => {
    const store = { ...CONFIGURED };
    const { ask, chrome } = loadWorker(store);
    await ask({ type: 'amz-note', text: 'blocked (captcha (3781b)) — pausing 60min', blockedForMs: 3600000 });
    const until = chrome.store.blockedUntil;
    assert.ok(until > Date.now() + 3500000, 'the deadline must be persisted, not just logged');
  });

  test('an ordinary note does NOT create a deadline', async () => {
    // Only a challenge pauses the lane. A miss or a parse warning must not silence it for an hour.
    const store = { ...CONFIGURED };
    const { ask, chrome } = loadWorker(store);
    await ask({ type: 'amz-note', text: '3 read nothing — [no known ids]' });
    assert.ok(!chrome.store.blockedUntil, 'a non-block note must leave the lane running');
  });

  test('being blocked never disables the bridge outright', async () => {
    // `enabled:false` would need a human to turn it back on; this has to resume by itself.
    const store = { ...CONFIGURED, blockedUntil: Date.now() + 60000 };
    const { ask } = loadWorker(store);
    const r = await ask({ type: 'amz-work' });
    assert.strictEqual(r.enabled, true);
  });
});
