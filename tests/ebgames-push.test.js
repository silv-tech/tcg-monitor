/**
 * EB Games is fed by a real browser, not by fetching.
 *
 * Cloudflare runs a managed JS challenge on ebgames.ca and scores the client rather than the
 * IP. Measured 2026-09-08 from a residential address, minutes apart: node fetch 403, curl 403,
 * patchright Chromium headless and headed both stuck on "Just a moment", real Chrome 200. So
 * no HTTP client and no proxy reaches this retailer, which is what the ~14,400 credits/day
 * paid route was actually buying. The companion extension browses the category pages in a
 * genuine profile and POSTs the HTML to /api/ingest/ebgames.
 *
 * The fixture is real card markup captured from the Pokemon category on 2026-09-08.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const EBGamesAdapter = require('../src/adapters/ebgames');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/ebgames-category.html'), 'utf8');
const CHALLENGE = '<html><head><title>Just a moment...</title></head><body>'
  + '<div id="challenge-running"></div>Enable JavaScript and cookies to continue</body></html>';

function adapter() {
  const a = new EBGamesAdapter({
    id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca', intervalMs: 5000,
  });
  a.pushOnly = true;
  // no Redis in unit tests — but honour `complete`, or the seed-window logic is untestable
  a._seedRedis = async (complete) => { if (complete) a._seeded = true; };
  // Likewise for hydration. state.js calls its OWN internal getRedis(), so stubbing the export
  // does not stop a real client being constructed — and its retry socket is a live handle that
  // keeps `node --test` running long after the assertions pass. Hydration has its own suite
  // (ebgames-hydrate.test.js), which stubs state.getAllProducts to exercise the real method.
  a._hydrateFromRedis = async () => {};
  // Any outbound call is a bug in push mode: the whole point is that we never touch the site.
  a._fetchListing = async () => { throw new Error('push mode must not fetch'); };
  a._deepCrawl = async () => { throw new Error('push mode must not crawl'); };
  return a;
}

describe('ebgames: a pushed listing feeds the normal pipeline', () => {
  test('real card markup parses and lands in the catalogue', async () => {
    const a = adapter();
    const r = await a.ingestPushed(FIXTURE, 'pokemon');
    assert.ok(r.parsed >= 2, `expected cards, got ${r.parsed}`);
    assert.strictEqual(r.known, a._knownProducts.size);
    const names = [...a._knownProducts.values()].map(p => p.name);
    assert.ok(names.some(n => /Ursaluna EX Box/.test(n)), 'sealed product must be tracked');
  });

  test('the shared scope rule is applied — an accessory does not enter the catalogue', async () => {
    const a = adapter();
    await a.ingestPushed(FIXTURE, 'pokemon');
    const names = [...a._knownProducts.values()].map(p => p.name).join(' | ');
    assert.ok(/Pro-Binder/.test(FIXTURE), 'precondition: the fixture contains a binder');
    assert.ok(!/Pro-Binder/.test(names), `a binder must not be tracked — got ${names}`);
  });

  test('the seed spans the whole first sweep, then switches to alerting', async () => {
    const a = adapter();
    const first = await a.ingestPushed(FIXTURE, 'pokemon');
    assert.strictEqual(first.seeded, true, 'first landing must seed Redis, not fire NEW_SKU');
    // A later page of the SAME sweep must ALSO seed. This is the whole fix: the single-page
    // bridge flipped after one push, so widening to a full-catalogue sweep would have stormed
    // the channel with a page of NEW_SKU/RESTOCK as each later page arrived.
    const second = await a.ingestPushed(FIXTURE, 'pokemon');
    assert.strictEqual(second.seeded, true, 'pages within the sweep window keep seeding, not alerting');
    // Once the window has elapsed, the next push completes the seed and alerting begins.
    a._seedStartedAt = Date.now() - (16 * 60 * 1000);
    const closing = await a.ingestPushed(FIXTURE, 'pokemon');
    assert.strictEqual(closing.seeded, true, 'the push that closes the window still seeds');
    const afterwards = await a.ingestPushed(FIXTURE, 'pokemon');
    assert.strictEqual(afterwards.seeded, false, 'after the window, pushes alert on real deltas');
  });

  test('products reach fetchProducts without any outbound request', async () => {
    const a = adapter();
    await a.ingestPushed(FIXTURE, 'pokemon');
    const products = await a.fetchProducts();   // would throw if it tried to fetch or crawl
    assert.ok(Object.keys(products).length >= 2);
  });
});

describe('ebgames: a push that is not a listing is refused', () => {
  const bad = [
    ['a Cloudflare challenge', CHALLENGE, /not a listing/i],
    ['an empty body', '', /empty body/i],
    // Over the 2000-char floor isChallenge enforces, so this reaches the parser and fails there.
    ['a page with no cards', `<html><body>${'x'.repeat(3000)}</body></html>`, /parsed 0 products/i],
  ];
  for (const [label, body, expected] of bad) {
    test(`${label} is rejected and changes nothing`, async () => {
      const a = adapter();
      await a.ingestPushed(FIXTURE, 'pokemon');
      const before = a._knownProducts.size;
      await assert.rejects(() => a.ingestPushed(body, 'pokemon'), expected);
      assert.strictEqual(a._knownProducts.size, before, 'a refused push must not alter the catalogue');
    });
  }

  test('an unknown source is rejected', async () => {
    await assert.rejects(() => adapter().ingestPushed(FIXTURE, 'nintendo'), /unknown source/i);
  });
});

describe('ebgames: a silent bridge shows up as stale, not as an empty store', () => {
  test('freshness drops once no push has landed for the stale window', async () => {
    const a = adapter();
    await a.ingestPushed(FIXTURE, 'pokemon');
    await a.fetchProducts();
    assert.deepStrictEqual(a._lastFreshness, { fresh: 1, attempted: 1 }, 'a live bridge is fresh');

    a._lastPushAt = Date.now() - 10 * 60 * 1000;   // PC asleep for ten minutes
    const products = await a.fetchProducts();
    assert.deepStrictEqual(a._lastFreshness, { fresh: 0, attempted: 1 }, 'a silent bridge is stale');
    assert.ok(Object.keys(products).length >= 2, 'but the last known catalogue is still reported');
  });
});
