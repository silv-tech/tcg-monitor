/**
 * A proven-wrong ASIN must stay gone.
 *
 * The adapter already detected identity drift — it compares the LIVE title against the scope rule
 * and drops the ASIN. But it dropped from memory only, so the decision evaporated:
 *
 *   - every restart re-hydrated the row from Redis under its stale in-scope Pokemon name, and the
 *     guard had to rediscover the same fact;
 *   - and in the meantime a search tile could re-admit it. That is not hypothetical: B0F1T9ND7G
 *     was measured still on page 1 of "pokemon booster pack" carrying the stale Pokemon title AND
 *     its old $22.96 price, while /dp/B0F1T9ND7G served a car jump starter. A re-admit arrives as
 *     inStock:true, which is precisely the wrong-product alert.
 *
 * Written ONLY on a confirmed live out-of-scope title — never on a failed, throttled or titleless
 * read, because those prove nothing. And reversible, because Amazon can repurpose a listing back.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;

const AmazonAdapter = require('../src/adapters/amazon');

const CFG = {
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
  adapter: 'amazon', intervalMs: 6000, proxyTier: 'isp', enabled: true, watchlist: [],
};

const GARDEVOIR = 'Pokémon TCG: Gardevoir ex League Battle Deck';
const JUMPSTARTER = 'DSPARK G21C 2000A 16000mAh Jump Starter, 12V Battery Booster';

let denied;
let stored;

beforeEach(() => {
  denied = new Map();
  stored = {};
  state.denyIdentity = async (retailerId, sku, reason) => { denied.set(sku, { reason }); };
  state.getDeniedIdentities = async () => denied;
  state.allowIdentity = async (retailerId, sku) => denied.delete(sku);
  state.getAllProducts = async () => stored;
});

function adapter(aod) {
  const a = new AmazonAdapter(CFG);
  a._stealthCheckAsin = async (asin) => (aod ? aod[asin] ?? null : null);
  return a;
}

const tile = (over = {}) => ({
  asin: 'B0F1T9ND7G', name: 'Pokemon - Surging Spark - Single Booster Pack', price: 22.96,
  inStock: true, url: 'https://www.amazon.ca/dp/B0F1T9ND7G', image: 'https://img/x.jpg', ...over,
});

describe('a stale search tile cannot resurrect a proven-wrong ASIN', () => {
  test('the tile is refused once the ASIN is denied', () => {
    const a = adapter();
    assert.ok(a._buildFromSearch(tile(), 'pokemon booster pack'),
      'precondition: this tile is otherwise perfectly acceptable');

    a._denied.add('B0F1T9ND7G');
    assert.strictEqual(a._buildFromSearch(tile(), 'pokemon booster pack'), null,
      'Amazon’s search index lags its product pages — the tile still says Pokemon');
  });

  test('other ASINs are unaffected', () => {
    const a = adapter();
    a._denied.add('B0F1T9ND7G');
    assert.ok(a._buildFromSearch(tile({ asin: 'B0OTHER123' }), 'pokemon booster pack'),
      'a denylist that blocks anything beyond its entries is worse than none');
  });
});

describe('the decision is recorded, and only on real evidence', () => {
  test('a confirmed out-of-scope live title denies the ASIN', () => {
    const a = adapter();
    a._denyIdentity('B0D2JGYX3F', 'Nex Playground');
    assert.ok(a._denied.has('B0D2JGYX3F'));
    assert.ok(denied.has('B0D2JGYX3F'), 'it must survive a restart, not just this process');
    assert.match(denied.get('B0D2JGYX3F').reason, /Nex Playground/,
      'the reason is what lets a human audit the decision later');
  });

  test('a Redis failure does not take down the poll', async () => {
    state.denyIdentity = async () => { throw new Error('ECONNREFUSED'); };
    const a = adapter();
    a._denyIdentity('B0D2JGYX3F', JUMPSTARTER);
    assert.ok(a._denied.has('B0D2JGYX3F'), 'the in-memory guard still holds for this process');
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('hydration honours the denylist', () => {
  test('a denied ASIN is not reloaded, even though its STORED name looks fine', async () => {
    denied.set('B0F1T9ND7G', { reason: JUMPSTARTER });
    stored = {
      B0F1T9ND7G: { sku: 'B0F1T9ND7G', name: 'Pokemon - Surging Spark - Single Booster Pack' },
      B0GOOD0001: { sku: 'B0GOOD0001', name: GARDEVOIR },
    };
    const a = adapter();
    await a._hydrateFromRedis();

    assert.ok(!a._knownProducts.has('B0F1T9ND7G'),
      'the stored name is the STALE in-scope one, so isInScopeName cannot catch this');
    assert.ok(a._knownProducts.has('B0GOOD0001'), 'real products still hydrate');
    assert.ok(a._denied.has('B0F1T9ND7G'), 'and the set is loaded for this process');
  });

  test('an empty denylist changes nothing', async () => {
    stored = { B0GOOD0001: { sku: 'B0GOOD0001', name: GARDEVOIR } };
    const a = adapter();
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 1);
  });

  test('a denylist read failure does not block hydration', async () => {
    state.getDeniedIdentities = async () => { throw new Error('redis down'); };
    stored = { B0GOOD0001: { sku: 'B0GOOD0001', name: GARDEVOIR } };
    const a = adapter();
    await a._hydrateFromRedis();
    assert.strictEqual(a._knownProducts.size, 1, 'degraded, not broken');
  });
});

describe('it is reversible', () => {
  test('clearing an entry lets the ASIN be tracked again', async () => {
    denied.set('B0F1T9ND7G', { reason: JUMPSTARTER });
    assert.strictEqual(await state.allowIdentity('amazon', 'B0F1T9ND7G'), true);
    assert.ok(!denied.has('B0F1T9ND7G'), 'Amazon can repurpose a listing back');
  });
});
