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
