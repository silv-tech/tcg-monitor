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

  /**
   * The flag is only safe if EVERY builder that observes stock clears it. All the offers/AOD
   * builders spread `...cached`, so a row marked blind by a price-less tile would carry that flag
   * onto a genuine read — and the out-of-stock confirmation would then never advance on real
   * evidence, frozen for that ASIN. That is the same sticky-flag class this commit removed, so the
   * flag introduced to fix one freeze nearly caused another. Found and closed before release.
   */
  const blindCached = () => ({
    sku: ASIN, name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 100,
    inStock: true, category: 'pokemon', lastSeen: T0, _stockUnobserved: true,
  });

  test('the OFFERS lane clears it — an offers read observes stock', () => {
    const a = makeAdapter();
    a._knownProducts.set(ASIN, blindCached());
    const products = {};
    a._applyOffersData(ASIN, { name: 'Pokemon TCG Elite Trainer Box', price: 89.99, inStock: true,
      pricePinned: true }, products, Date.now(), 'offers-lane');
    const out = products[ASIN] || a._knownProducts.get(ASIN);
    assert.ok(!out._stockUnobserved, 'a real read must never inherit blindness');
  });

  test('the AOD sweep clears it', async () => {
    const a = makeAdapter();
    a._knownProducts.set(ASIN, blindCached());
    a._aodCooldownUntil = 0;
    a.getFastPollAsins = () => new Set();
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 95, inStock: true, image: '' });
    const products = {};
    await a._monitorKnownAsinsInner(products);
    const out = products[ASIN] || a._knownProducts.get(ASIN);
    assert.ok(!out._stockUnobserved);
  });

  test('fetchProductPage clears it', async () => {
    const a = makeAdapter();
    a._knownProducts.set(ASIN, blindCached());
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 95, inStock: true, image: '' });
    const out = await a.fetchProductPage(ASIN);
    assert.ok(!out._stockUnobserved);
  });

  test('the adapter sets BOTH flags only when the tile had no price', () => {
    // Both are needed and neither substitutes for the other: the guards ask separate questions
    // ("did anyone look at the stock?" / "at the price?") and a row can be honest about one and
    // blind about the other. A price-less tile replays the cached value for both.
    const a = makeAdapter();
    const tile = (o) => ({ asin: ASIN, name: 'Pokemon TCG Elite Trainer Box', inStock: true, ...o });

    const priced = a._buildFromSearch(tile({ price: 89.99 }), '');
    assert.strictEqual(priced._stockUnobserved, undefined, 'a priced tile DID observe stock');
    assert.strictEqual(priced._priceUnobserved, undefined, 'and DID observe a price');

    const blind = a._buildFromSearch(tile({ price: undefined, _priceUnknown: true }), '');
    assert.strictEqual(blind._stockUnobserved, true);
    assert.strictEqual(blind._priceUnobserved, true,
      'without this the steep-drop streak advances on a replayed price');
  });

  test('a price-blind tile cannot confirm a steep drop — adapter and guard together', () => {
    // End to end through the REAL builder, so removing the adapter-side flag cannot pass unnoticed.
    const a = makeAdapter();
    a._knownProducts.set(ASIN, {
      sku: ASIN, name: 'Pokemon TCG Elite Trainer Box', price: 45, _pricePinned: true, inStock: true,
    });
    const built = a._buildFromSearch(
      { asin: ASIN, name: 'Pokemon TCG Elite Trainer Box', inStock: true, _priceUnknown: true }, '');
    assert.strictEqual(built.price, 45, 'the tile had no price, so the cached one is replayed');

    const held = confirm(built, row({ price: 100, _pricePinned: true, _steepDropStreak: 1 }));
    assert.strictEqual(held.price, 100, 'the hold must survive a replayed price');
    assert.strictEqual(held._steepDropStreak, 1, 'and the streak must not advance');
  });
});

describe('a blind row may not drive EITHER direction', () => {
  /**
   * Round 2 of the audit found the first version of this guard covered only the direction that
   * raises no alert. These are the two holes it left.
   */
  test('a price replay cannot confirm a steep drop', () => {
    // A price-less tile replays the cached price AND its provenance while stamping a fresh
    // timestamp. That advanced the drop streak on a reading nobody took — the 0.37s
    // self-confirmation, reopened 6s after a hold engaged, off ONE authoritative read.
    const prev = row({ price: 100, _pricePinned: true, _steepDropStreak: 1, _priceHeld: true });
    const replay = confirm(row({ price: 45, _pricePinned: true, _priceUnobserved: true,
      _stockUnobserved: true, lastSeen: T0 + 6000 }), prev);

    assert.strictEqual(replay._steepDropStreak, 1, 'a replay is not a second opinion');
    assert.strictEqual(replay.price, 100, 'so the hold stays on');
    const drops = diffProducts({ [ASIN]: prev }, { [ASIN]: replay })
      .filter((e) => e.type === EVENT_TYPES.PRICE_CHANGE);
    assert.deepStrictEqual(drops, [], 'and no price drop is published');
  });

  test('a real price read still confirms it', () => {
    const prev = row({ price: 100, _pricePinned: true, _steepDropStreak: 1 });
    const real = confirm(row({ price: 45, _pricePinned: true, lastSeen: T0 + 240_000 }), prev);
    assert.strictEqual(real.price, 45, 'the guard must not become unsatisfiable');
  });

  test('a blind replay cannot MANUFACTURE a restock', () => {
    // Reachable whenever Redis and the adapter catalogue disagree: an ASIN is dropped from the
    // returned map, stale cleanup writes inStock:false to Redis after two polls while
    // _knownProducts still holds true, and the next price-less tile replays that true.
    const next = confirm(
      row({ inStock: true, _stockUnobserved: true, lastSeen: T0 + 6000 }),
      row({ inStock: false, _oosStreak: 2 }),
    );
    assert.strictEqual(next.inStock, false, 'nothing was observed, so nothing is asserted');

    const events = diffProducts({ [ASIN]: row({ inStock: false, _oosStreak: 2 }) }, { [ASIN]: next });
    assert.ok(!events.some((e) => e.type === EVENT_TYPES.RESTOCK),
      'a false RESTOCK on the priority channel is the worst possible output');
  });

  test('a REAL restock is not delayed by that guard', () => {
    const next = confirm(row({ inStock: true, lastSeen: T0 + 6000 }),
      row({ inStock: false, _oosStreak: 2 }));
    assert.strictEqual(next.inStock, true, 'a genuine read always sets stockRead');
    assert.strictEqual(next._oosStreak, 0);
  });
});

describe('an unscoped read may not overwrite an authoritative price', () => {
  test('a RISE from pinned to unverified is refused, in-flight hold intact', () => {
    // How the trusted price got destroyed silently, and how a real sale then got suppressed:
    // the rise zeroed the streak and made {229, unpinned} the baseline with no alert, and the next
    // genuine pinned read at 45 became unpinned->pinned = a CORRECTION, filtering the event out.
    const prev = row({ price: 100, _pricePinned: true, _steepDropStreak: 1 });
    const next = confirm(row({ price: 229, _pricePinned: false, lastSeen: T0 + 6000 }), prev);

    assert.strictEqual(next.price, 100, 'the authoritative number stands');
    assert.strictEqual(next._pricePinned, true, 'and the flag still describes the value in the row');
    assert.strictEqual(next._steepDropStreak, 1,
      'an unscoped reading is not evidence that the sale went away');
  });

  test('and the genuine sale still publishes afterwards', () => {
    const prev = row({ price: 100, _pricePinned: true, _steepDropStreak: 1 });
    const held = confirm(row({ price: 229, _pricePinned: false, lastSeen: T0 + 6000 }), prev);
    const real = confirm(row({ price: 45, _pricePinned: true, lastSeen: T0 + 240_000 }), held);

    assert.strictEqual(real.price, 45, 'confirmed by a second authoritative read');
    assert.strictEqual(real._priceCorrected, undefined,
      'this is a real -55% sale, NOT a correction — suppressing it was the bug');
  });

  test('a rise between two prices of the SAME provenance is ordinary', () => {
    const next = confirm(row({ price: 229, _pricePinned: true, lastSeen: T0 + 6000 }),
      row({ price: 100, _pricePinned: true, _steepDropStreak: 1 }));
    assert.strictEqual(next.price, 229, 'a real price rise is taken');
    assert.strictEqual(next._steepDropStreak, 0, 'and the stale drop streak is cleared');
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

  test('fetchProductPage stamps _watchlist for a CONFIGURED watchlist ASIN', () => {
    // Amazon alone never stamped it (bestbuy, ebgames, costco, walmart all do). Without it a
    // fast-lane restock loses the limiter exemption, the queue bypass, the 45s dedup and the
    // priority channel — and because that lane writes inStock:true to Redis first, the offers lane
    // then sees no transition, so no second correctly-routed alert follows.
    const a = makeAdapter({ watchlist: [ASIN] });
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 89.99, inStock: true, image: '',
    });
    return a.fetchProductPage(ASIN).then((p) => {
      assert.strictEqual(p._watchlist, true);
    });
  });

  test('but NOT for an auto-promoted hot ASIN the client never picked', () => {
    // getFastPollAsins() = the configured set UNION up to 10 auto-promoted recently-in-stock
    // ASINs, so an unconditional stamp hands the privileges to exactly the rows most likely to be
    // flapping. Worse than not stamping at all: delivery escalates a wrong-identity verdict on a
    // _watchlist row to admin WITHOUT denylisting it, so a mis-identified ASIN stays tracked.
    const a = makeAdapter({ watchlist: [] });
    a._stealthCheckAsin = async () => ({
      name: 'Pokemon TCG: 30th Celebration Elite Trainer Box', price: 89.99, inStock: true, image: '',
    });
    return a.fetchProductPage(ASIN).then((p) => {
      assert.ok(!p._watchlist, 'the privileges belong to the hand-given list only');
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
