/**
 * EB Games extension: the page-sweep math.
 *
 * The bridge now walks every page of the category (page 1 -> last -> back to 1) instead of
 * reloading page 1, because in-stock products live on deeper pages (verified live 2026-09-09:
 * write_date pages 1-2 were 0/24 in stock; in-stock first appeared on page 3+). This exercises
 * the ACTUAL pure functions from background.js by running its real source in a vm with a stubbed
 * `chrome`, so the Chrome glue does not run but the exported math is the real thing — not a copy.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBackground() {
  const src = fs.readFileSync(path.join(__dirname, '../ebgames-extension/background.js'), 'utf8');
  const noop = () => {};
  const chrome = {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop }, onStartup: { addListener: noop }, openOptionsPage: noop },
    action: { onClicked: { addListener: noop } },
    alarms: { create: noop, onAlarm: { addListener: noop } },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: noop } },
    tabs: { query: async () => [], create: async () => {}, update: async () => {} },
  };
  const sandbox = { chrome, module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

describe('ebgames extension: page-sweep math (real source via vm)', () => {
  const { pageUrl, nextPage } = loadBackground();

  test('exports are wired', () => {
    assert.strictEqual(typeof pageUrl, 'function');
    assert.strictEqual(typeof nextPage, 'function');
  });

  test('page 1 is the bare category URL; page N uses the /page/N path', () => {
    const base = 'https://www.ebgames.ca/shop/category/trading-cards-pokemon-204';
    assert.strictEqual(pageUrl(base, 1), `${base}?order=create_date+desc`);
    assert.strictEqual(pageUrl(base, 2), `${base}/page/2?order=create_date+desc`);
    assert.strictEqual(pageUrl(base, 21), `${base}/page/21?order=create_date+desc`);
    // defensive: junk page falls back to page 1, never a broken URL
    assert.strictEqual(pageUrl(base, 0), `${base}?order=create_date+desc`);
    assert.strictEqual(pageUrl(base, undefined), `${base}?order=create_date+desc`);
  });

  test('the sweep advances one page and wraps after the last', () => {
    assert.strictEqual(nextPage(1, 21), 2, 'advance');
    assert.strictEqual(nextPage(20, 21), 21, 'advance to last');
    assert.strictEqual(nextPage(21, 21), 1, 'wrap after last -> full loop');
    assert.strictEqual(nextPage(1, 1), 1, 'single-page category stays on page 1');
  });

  test('a full loop visits every page exactly once (no skip, no infinite grow)', () => {
    const max = 21;
    const seen = new Set();
    let p = 1;
    for (let i = 0; i < max; i++) { seen.add(p); p = nextPage(p, max); }
    assert.strictEqual(seen.size, max, 'every page 1..max visited');
    assert.strictEqual(p, 1, 'back to page 1 after a full loop');
  });

  test('bad inputs never produce a page below 1 or above max', () => {
    assert.strictEqual(nextPage(0, 5), 2);       // 0 clamps to page 1, then advances to 2
    assert.strictEqual(nextPage(-3, 5), 2);      // clamped to 1, then +1
    assert.strictEqual(nextPage(99, 5), 1);      // past the end wraps
    assert.strictEqual(nextPage(2, 0), 1);       // max<1 clamped to 1 -> wrap
    // whatever the inputs, the result is always a valid page in 1..max
    for (const [pg, mx] of [[0,5],[-3,5],[99,5],[2,0],[NaN,3],[1,NaN]]) {
      const n = nextPage(pg, mx);
      assert.ok(n >= 1 && n <= Math.max(1, Number(mx) || 1), `nextPage(${pg},${mx})=${n} out of range`);
    }
  });
});
