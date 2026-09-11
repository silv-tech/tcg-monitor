/**
 * The six defects the 2026-09-12 Amazon audit turned up, each pinned by a test that fails without
 * its fix. Four were found by an adversarial agent and reproduced by hand before being fixed.
 *
 * Why these tests exist in this shape: the pre-existing OOS/merge suites reimplement poll-adapter's
 * logic in local helpers and assert against the copy, which is exactly how the earlier
 * shared-object bug shipped green. Everything here drives the REAL exported function or the REAL
 * adapter method.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { confirmObservation } = require('../src/core/poll-adapter');
const { buildAlertEmbed } = require('../src/discord/embeds');
const { EVENT_TYPES, diffProducts } = require('../src/core/events');
const AmazonAdapter = require('../src/adapters/amazon');

const T0 = 1_757_600_000_000;
const ASIN = 'B0H78BB9TY';

const row = (o = {}) => ({
  sku: ASIN, name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', retailer: 'Amazon Canada',
  retailerId: 'amazon', inStock: true, price: 100, lastSeen: T0, ...o,
});
const confirm = (observed, prev) => confirmObservation(observed, prev, 'Amazon Canada', ASIN);

const makeAdapter = (over = {}) => new AmazonAdapter({
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000,
  ...over,
});

describe('poll-adapter owns its own bookkeeping — the adapter never supplies it', () => {
  /**
   * ROOT CAUSE. These flags are written into the stored row; amazon.js `_hydrateFromRedis` reads
   * that row back into `_knownProducts`; every later poll re-emits them as though observed. Nothing
   * cleared them, and the code's own comments record 37 deploys in 28h, so hydration is frequent.
   */
  test('a stale _priceCorrected cannot suppress a later REAL price drop', () => {
    const prev = row({ price: 100, _pricePinned: true, _priceCorrected: true });
    const next = confirm(row({ price: 80, _pricePinned: true, _priceCorrected: true,
      lastSeen: T0 + 240_000 }), prev);

    assert.strictEqual(next._priceCorrected, undefined,
      'a replayed flag must not survive, or the event filter drops every future price change');

    const drops = diffProducts({ [ASIN]: prev }, { [ASIN]: next })
      .filter((e) => e.type === EVENT_TYPES.PRICE_CHANGE);
    assert.strictEqual(drops.length, 1, 'a genuine -20% move is ordinary news and must go out');
    assert.ok(!drops[0].product._priceCorrected, 'and must not carry the suppression flag');
  });

  test('a stale _priceHeld cannot print "TBD (verifying)" over a price we trust', () => {
    const next = confirm(
      row({ price: 89.99, _pricePinned: true, inStock: true, _priceHeld: true, lastSeen: T0 + 240_000 }),
      row({ price: 89.99, _pricePinned: true, inStock: false, _priceHeld: true }),
    );
    assert.strictEqual(next._priceHeld, undefined);

    const { embed } = buildAlertEmbed({ type: EVENT_TYPES.RESTOCK, product: next,
      oldValue: false, newValue: true });
    const price = embed.data.fields.find((f) => f.name === 'Price').value;
    assert.match(price, /89\.99/, 'the client must see the real price on a priority restock');
  });

  test('a stale _steepDropStreak cannot publish a steep drop off ONE observation', () => {
    const next = confirm(
      row({ price: 60, _pricePinned: true, lastSeen: T0 + 6000 }),
      row({ price: 150, _pricePinned: true, _steepDropStreak: 1 }),
    );
    // prev's streak IS authoritative, so 1 -> 2 is correct here; what must not happen is the
    // observation carrying its own stale streak in and skipping the hold.
    const fromReplayedFlag = confirm(
      row({ price: 60, _pricePinned: true, _steepDropStreak: 1, lastSeen: T0 + 6000 }),
      row({ price: 150, _pricePinned: true }),
    );
    assert.strictEqual(fromReplayedFlag.price, 150, 'held — the adapter-supplied streak is ignored');
    assert.strictEqual(fromReplayedFlag._steepDropStreak, 1);
    assert.ok(next, 'and the legitimate stored-streak path still works');
  });

  test('a price RISE resets the drop streak — it used to match no branch at all', () => {
    const afterRise = confirm(row({ price: 150, lastSeen: T0 + 6000 }),
      row({ price: 100, _steepDropStreak: 1 }));
    assert.strictEqual(afterRise._steepDropStreak, 0,
      'a drop streak means nothing once the price is rising; leaving it at 1 armed the next drop');
  });

  test('a price going to zero on an OOS read also resets it', () => {
    const next = confirm(row({ price: 0, inStock: false, lastSeen: T0 + 6000 }),
      row({ price: 100, _steepDropStreak: 1 }));
    assert.strictEqual(next._steepDropStreak, 0, 'zero is "unknown", never a 100% discount');
  });
});

describe('a row can be fresh about price and blind about stock', () => {
  /**
   * Amazon's search tiles: no price string and no "Currently unavailable" means the tile carries NO
   * stock signal, so the builder replays `cached.inStock` — but it also stamps a fresh `lastSeen`.
   * The read-counting guard would have read that as "somebody looked" and confirmed a held
   * sell-out off a reading nobody took. 43 of 90 measured tiles had no price, so this is the
   * common case.
   */
  test('a stock-blind row does NOT advance the out-of-stock confirmation', () => {
    const held = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), row({ inStock: true }));
    assert.strictEqual(held._oosStreak, 1);
    assert.strictEqual(held.inStock, true, 'held, as designed');

    const blind = confirm(
      row({ inStock: false, _stockUnobserved: true, lastSeen: T0 + 7000 }), held);
    assert.strictEqual(blind._oosStreak, 1, 'the replay must not count as the second look');
    assert.strictEqual(blind.inStock, true, 'so the hold stays on');
  });

  test('a real second read still confirms it', () => {
    const held = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), row({ inStock: true }));
    const real = confirm(row({ inStock: false, lastSeen: T0 + 240_000 }), held);
    assert.strictEqual(real.inStock, false, 'the guard must not become unsatisfiable');
  });

  test('stock-blindness does not touch the price guards', () => {
    // Only the stock direction is blind; the price in such a row is still a real read.
    const next = confirm(
      row({ price: 40, _pricePinned: true, _stockUnobserved: true, lastSeen: T0 + 240_000 }),
      row({ price: 100, _pricePinned: true, _steepDropStreak: 1 }),
    );
    assert.strictEqual(next.price, 40, 'a confirmed steep drop still lands');
  });

  test('the adapter sets the flag only when the tile had no price', () => {
    const a = makeAdapter();
    const tile = (o) => ({ asin: ASIN, name: 'Pokemon TCG Elite Trainer Box', inStock: true, ...o });

    const priced = a._buildFromSearch(tile({ price: 89.99 }), '');
    assert.strictEqual(priced._stockUnobserved, undefined, 'a priced tile DID observe stock');

    const blind = a._buildFromSearch(tile({ price: undefined, _priceUnknown: true }), '');
    assert.strictEqual(blind._stockUnobserved, true);
  });
});

describe('provenance follows the value in EVERY price path', () => {
  test('the AOD sweep does not inherit pinned provenance', async () => {
    // Same defect _buildFromSearch had: `{...cached, price: data.price || cached.price}` carries
    // _pricePinned forward onto a price that did not come from the pinned offer. _parseAod takes
    // the first price ANYWHERE in the fragment — the OLID is scoped to the pinned block, the price
    // is not — so an AOD price is never authoritative. Driven through the real sweep.
    const a = makeAdapter();
    a._knownProducts.set(ASIN, {
      sku: ASIN, name: 'Pokemon TCG: 30th Celebration Elite Trainer Box',
      price: 89.99, _pricePinned: true, inStock: true, category: 'pokemon', lastSeen: T0,
    });
    a._aodCooldownUntil = 0;
    a.getFastPollAsins = () => new Set();       // keep the ASIN in the sweep's scope
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 229, inStock: true, image: '',
    });

    const products = {};
    await a._monitorKnownAsinsInner(products);

    const out = products[ASIN] || a._knownProducts.get(ASIN);
    assert.strictEqual(out.price, 229, 'the sweep took the AOD price');
    assert.strictEqual(out._pricePinned, false,
      'claiming pinned here lets the next real pinned read look like a pinned->pinned steep drop, '
      + 'which publishes after one confirmation — the false -61% through this lane');
  });

  test('the AOD sweep keeps provenance when the cached price survives', async () => {
    const a = makeAdapter();
    a._knownProducts.set(ASIN, {
      sku: ASIN, name: 'Pokemon TCG: 30th Celebration Elite Trainer Box',
      price: 89.99, _pricePinned: true, inStock: true, category: 'pokemon', lastSeen: T0,
    });
    a._aodCooldownUntil = 0;
    a.getFastPollAsins = () => new Set();
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: null, inStock: true, image: '',
    });

    const products = {};
    await a._monitorKnownAsinsInner(products);

    const out = products[ASIN] || a._knownProducts.get(ASIN);
    assert.strictEqual(out.price, 89.99, 'nothing replaced it');
    assert.strictEqual(out._pricePinned, true, 'so nothing about its provenance changed');
  });

  test('fetchProductPage keeps a known price when AOD could not parse one', () => {
    const a = makeAdapter();
    a._knownProducts.set(ASIN, { sku: ASIN, price: 89.99, _pricePinned: true, inStock: false });
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: null, inStock: true, image: '',
    });

    return a.fetchProductPage(ASIN).then((p) => {
      assert.ok(p, 'the read is usable');
      assert.strictEqual(p.price, 89.99,
        'wiping this to null destroyed the stored price, the history and /scan, and dropped events');
      assert.strictEqual(p._pricePinned, true, 'the surviving price keeps its own provenance');
    });
  });

  test('fetchProductPage marks a freshly parsed AOD price as NOT authoritative', () => {
    const a = makeAdapter();
    a._knownProducts.set(ASIN, { sku: ASIN, price: 89.99, _pricePinned: true });
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 229, inStock: true, image: '',
    });

    return a.fetchProductPage(ASIN).then((p) => {
      assert.strictEqual(p.price, 229);
      assert.strictEqual(p._pricePinned, false, 'AOD prices are unscoped — claiming pinned is the lie');
    });
  });

  test('fetchProductPage stamps _watchlist, as every other adapter does', () => {
    const a = makeAdapter();
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 89.99, inStock: true, image: '',
    });
    return a.fetchProductPage(ASIN).then((p) => {
      assert.strictEqual(p._watchlist, true,
        'without it a fast-lane restock loses the limiter exemption, the queue bypass, the 45s '
        + 'dedup and the priority channel — and no second alert follows');
    });
  });
});

describe('no priority ASIN is ever excluded', () => {
  const ASINS = Array.from({ length: 24 }, (_, i) => `B0TEST${String(i).padStart(4, '0')}`);

  test('all 24 go into ONE free query — slice(0,20) silently dropped four', () => {
    const a = makeAdapter({ priorityAsins: ASINS });
    let asked = null;
    a._freeSearch = async (q) => { asked = q; return []; };

    return a._runPriorityFreeCheck({}).then(() => {
      assert.ok(asked, 'the free lane ran');
      const sent = asked.split('|');
      assert.strictEqual(sent.length, 24, 'every ASIN in a single request');
      for (const asin of ASINS) assert.ok(sent.includes(asin), `${asin} must not be excluded`);
    });
  });

  test('a list longer than one result grid rotates rather than truncating', async () => {
    const many = Array.from({ length: 90 }, (_, i) => `B0BIG${String(i).padStart(5, '0')}`);
    const a = makeAdapter({ priorityAsins: many });
    const seen = new Set();
    a._freeSearch = async (q) => { q.split('|').forEach((x) => seen.add(x)); return []; };

    for (let i = 0; i < 3; i++) await a._runPriorityFreeCheck({});
    assert.strictEqual(seen.size, 90, 'delayed by a poll or two, never dropped');
  });

  test('the product cap has headroom — truncation excludes ASINs silently', () => {
    const cfg = require('../src/config/retailers.json');
    const list = Array.isArray(cfg) ? cfg : (cfg.retailers || Object.values(cfg));
    const amazon = list.find((r) => r && r.id === 'amazon');
    assert.ok(amazon.maxProducts >= 1000,
      'measured 656 stored against a 700 cap; truncation logs at warn and drops the tail');
  });
});

describe('a blocked search must not silence the offers lanes', () => {
  test('the offers lanes still run while search is quiet', async () => {
    // One poll whose keyword searches all fail used to buy 60s (escalating to 900s) of ZERO
    // restock detection, because the early return skipped _runDiscovery — where the offers lanes
    // and the burst live. Those go through ScraperAPI, which was never blocked.
    const a = makeAdapter({ priorityAsins: [ASIN] });
    a._searchBlockedUntil = Date.now() + 60_000;
    a._knownProducts.set(ASIN, { sku: ASIN, name: 'x', price: 10, inStock: false, lastSeen: T0 });

    const called = [];
    a._runOffersLane = async () => { called.push('offers'); };
    a._runPriorityOffersLane = async () => { called.push('priorityOffers'); };
    a._runDiscovery = async () => { called.push('discovery'); };   // must NOT run
    a._hydrateFromRedis = async () => {};
    a._seedFirstRead = async () => {};

    const products = await a.fetchProducts();

    assert.ok(called.includes('offers'), 'the guaranteed per-ASIN stock check must keep running');
    assert.ok(called.includes('priorityOffers'), 'and the client priority lane with it');
    assert.ok(!called.includes('discovery'), 'while every free /s lane stays quiet, so the block decays');
    assert.ok(ASIN in products, 'cached rows are still carried forward');
  });

  test('a fresh offers read is not overwritten by its own cached row', async () => {
    const a = makeAdapter();
    a._searchBlockedUntil = Date.now() + 60_000;
    a._knownProducts.set(ASIN, { sku: ASIN, name: 'x', price: 10, inStock: false, lastSeen: T0 });
    a._runOffersLane = async (products) => {
      products[ASIN] = { sku: ASIN, name: 'x', price: 10, inStock: true, lastSeen: T0 + 5000 };
    };
    a._runPriorityOffersLane = async () => {};
    a._hydrateFromRedis = async () => {};
    a._seedFirstRead = async () => {};

    const products = await a.fetchProducts();
    assert.strictEqual(products[ASIN].inStock, true,
      'the carry-forward must be conditional, or the restock it just found is erased');
  });
});
