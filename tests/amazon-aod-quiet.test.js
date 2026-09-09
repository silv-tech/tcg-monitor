/**
 * When Amazon's AOD endpoint blocks, EVERY AOD lane must go quiet — not just the sweep.
 *
 * AOD is throttled endpoint-wide, and a block only decays when we STOP hitting it (this repo's
 * search-quiet ladder learned the same lesson: a lightly-loaded block lifted in ~23min, a
 * continuously-poked one stayed dead 2h+). The sweep already backed off on its 10-min cooldown,
 * but the auto-hot lane (`fetchProductPage`) and price-fill did NOT check `_aodCooldownUntil`, so
 * they kept knocking every ~30s and held the block open. Observed live on the cf4b6fa deploy:
 * AOD 503'd continuously for 30+ minutes, the watchlist ASINs re-probed every 30s, no recovery.
 *
 * Fix: gate _stealthCheckAsin (the single AOD choke point) on the cooldown so all lanes pause
 * together, and count a 503 from ANY lane toward tripping that cooldown (not only the sweep).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const rateBudget = require('../src/utils/rate-budget');

const state = require('../src/core/state');
state.cacheOfferListingId = async () => {};
state.cacheSellerInfo = async () => {};

function adapter() {
  const a = new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
    intervalMs: 6000, proxyTier: 'none', watchlist: ['B0H77W4411'],
  });
  a.reportFreshness = () => {};
  return a;
}

const realAcquire = rateBudget.acquire;
afterEach(() => { rateBudget.acquire = realAcquire; rateBudget._reset(); });

describe('a 503 from any lane trips the shared cooldown', () => {
  test('two strikes pause all lanes; one does not', () => {
    const a = adapter();
    assert.strictEqual(a._aodCooldownUntil, 0);
    a._aodStrike();
    assert.strictEqual(a._aodCooldownUntil, 0, 'one strike is not enough');
    a._aodStrike();
    assert.ok(a._aodCooldownUntil > Date.now(), 'two strikes pause every AOD lane');
    assert.strictEqual(a._aodThrottleStreak, 0, 'streak resets after tripping so it re-arms cleanly');
  });
});

describe('during the cooldown, no lane touches the endpoint', () => {
  test('the HOT lane (fetchProductPage) makes NO AOD request while blocked', async () => {
    const a = adapter();
    a._aodCooldownUntil = Date.now() + 60_000;
    let acquired = 0;
    rateBudget.acquire = async () => { acquired++; return true; };
    const r = await a.fetchProductPage('B0H77W4411');
    assert.strictEqual(r, null, 'hot lane returns null during the cooldown');
    assert.strictEqual(acquired, 0, 'gated BEFORE the budget — the endpoint is not hit at all');
  });

  test('_stealthCheckAsin is gated for the sweep/background priority too', async () => {
    const a = adapter();
    a._aodCooldownUntil = Date.now() + 60_000;
    let acquired = 0;
    rateBudget.acquire = async () => { acquired++; return true; };
    const r = await a._stealthCheckAsin('B0X', 1);
    assert.strictEqual(r, null);
    assert.strictEqual(acquired, 0);
  });

  test('the sweep skips entirely and carries the cache forward (no false OOS) while blocked', async () => {
    const a = adapter();
    for (let i = 0; i < 5; i++) {
      a._knownProducts.set('B0C' + i, { sku: 'B0C' + i, name: 'Pokemon TCG Box ' + i, category: 'pokemon', price: 10, inStock: true });
    }
    a._aodCooldownUntil = Date.now() + 60_000;
    let acquired = 0;
    rateBudget.acquire = async () => { acquired++; return true; };
    const products = {};
    await a._monitorKnownAsins(products);
    assert.strictEqual(acquired, 0, 'sweep makes zero AOD calls during the cooldown');
    assert.deepStrictEqual(products.B0C0, a._knownProducts.get('B0C0'), 'cached row carried forward unchanged');
  });

  test('a budget miss during no cooldown still is not a throttle (regression guard)', async () => {
    const a = adapter();
    rateBudget.acquire = async () => false; // out of budget, not a 503
    a._lastFetchThrottled = true;
    const r = await a._stealthCheckAsin('B0X', 1);
    assert.strictEqual(r, null);
    assert.strictEqual(a._lastFetchThrottled, false, 'a budget miss must not read as a throttle');
    assert.strictEqual(a._aodThrottleStreak, 0, 'and must not count toward the cooldown');
  });
});

describe('the AOD cooldown escalates on repeated blocks (quiet ladder)', () => {
  const mins = (a) => Math.round((a._aodCooldownUntil - Date.now()) / 60000);
  // A fresh block: the prior cooldown window has expired (retry time), then two 503s trip it again.
  const nextBlock = (a) => { a._aodCooldownUntil = 0; a._aodStrike(); a._aodStrike(); };

  test('consecutive blocks wait 10, then 20, then 40 min, capped at 40', () => {
    const a = adapter();
    nextBlock(a); assert.strictEqual(mins(a), 10, 'first block: shortest wait');
    nextBlock(a); assert.strictEqual(mins(a), 20, 'second block: longer');
    nextBlock(a); assert.strictEqual(mins(a), 40, 'third block: longest');
    nextBlock(a); assert.strictEqual(mins(a), 40, 'stays capped at the top rung — never unbounded');
    assert.strictEqual(a._aodCooldownLevel, 4);
  });

  test('a real read resets the ladder to the shortest wait', () => {
    const a = adapter();
    nextBlock(a); nextBlock(a);              // climbed to level 2
    assert.strictEqual(a._aodCooldownLevel, 2);
    a._aodRecovered();                        // what a successful AOD read does
    assert.strictEqual(a._aodCooldownLevel, 0, 'recovery drops back to the bottom rung');
    nextBlock(a); assert.strictEqual(mins(a), 10, 'next block starts short again');
  });

  test('one isolated throttle is still just the short cooldown', () => {
    const a = adapter();
    nextBlock(a);
    assert.strictEqual(mins(a), 10, 'a one-off blip does not over-penalize');
  });

  test('extra 503s WITHIN an active cooldown do not climb the ladder (no rung-skipping)', () => {
    const a = adapter();
    nextBlock(a);                             // one real block → level 1, 10 min
    assert.strictEqual(a._aodCooldownLevel, 1);
    // Simulate in-flight/sibling-lane 503s arriving while the cooldown is still active:
    a._aodStrike(); a._aodStrike(); a._aodStrike();
    assert.strictEqual(a._aodCooldownLevel, 1, 'still level 1 — one outage escalates at most once');
    assert.strictEqual(mins(a), 10, 'the window is not extended by re-strikes');
  });
});
