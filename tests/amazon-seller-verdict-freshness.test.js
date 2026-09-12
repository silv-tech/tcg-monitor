/**
 * A stale third-party-seller verdict must never suppress a restock.
 *
 * THE BUG, confirmed firing in production 2026-09-12. `delivery.js` read the seller from a cache
 * with a 30-day TTL and refetched ONLY when that cache was empty. A seller is not a property of the
 * ASIN — it is whoever holds the buy box right now, and it changes every time stock changes. So the
 * cache was poisoned exactly when it does the most damage:
 *
 *   Amazon goes out of stock -> a marketplace seller takes the buy box (the NORMAL resting state
 *   of an out-of-stock ASIN) -> "Japan Big Mall" is cached -> Amazon restocks -> the month-old
 *   verdict suppresses the alert, and the refetch never runs because the cache is not empty.
 *
 * There was no exemption for the client's hand-picked ASINs: the identity gate has a `_watchlist`
 * escalation branch, this gate had none. B0GW2DK37Q restocked, was verified by five independent
 * paid offers reads at $39.95, and was dropped at the last step.
 *
 * THE FIX. On the events where the verdict matters — a restock, a preorder going live, or anything
 * on the priority list — the seller is read LIVE and the cache refreshed. If the live read fails we
 * fail OPEN and explicitly do NOT fall back to the cached verdict. The TTL also drops from 30 days
 * to 6 hours so every other path is bounded rather than relying on that one gate.
 *
 * These tests drive the REAL `enrichEvent`. delivery.js destructures its helpers from `state` and
 * `scraper-api` at import time, so the stubs are installed BEFORE it is required — patching after
 * would leave the real functions bound and open a live Redis socket (which hangs `node --test`).
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── stubs, installed before delivery.js is required ───────────────────────────────────────────
const state = require('../src/core/state');
const scraperApi = require('../src/utils/scraper-api');
const browser = require('../src/utils/browser');

const HOUR = 3600_000;
const calls = {
  cacheReads: 0, liveFetches: 0, cachedSeller: null, liveSeller: null, cacheWrites: [],
  cachedAgeMs: 5 * HOUR,   // old by default; individual tests set it
};

state.getRestockHistory = async () => [];
state.getPriceHistory = async () => [];
state.findCrossRetailerMatches = async () => [];
state.getLastCheck = async () => Date.now();
state.getOfferListingId = async () => 'OLID-CACHED';
state.cacheOfferListingId = async () => {};
state.getSellerCache = async () => { calls.cacheReads++; return calls.cachedSeller; };
state.getSellerCacheAgeMs = async () => calls.cachedAgeMs;
state.cacheSellerInfo = async (asin, s) => { calls.cacheWrites.push(s); };
scraperApi.fetchAmazonOlidAndSeller = async () => {
  calls.liveFetches++;
  return { olid: 'OLID-LIVE', seller: calls.liveSeller };
};
browser.scrapeAmazonOfferListingId = async () => ({ olid: null, seller: null });

const delivery = require('../src/discord/delivery');

const ASIN = 'B0GW2DK37Q';
const event = (over = {}) => {
  const { product: productOver, ...rest } = over;   // spread `rest` LAST without clobbering product
  return {
    type: 'RESTOCK',
    oldValue: false,
    newValue: true,
    ...rest,
    product: {
      sku: ASIN, name: 'Pokemon TCG First Partner Illustration Collection Series 2',
      retailerId: 'amazon', retailer: 'Amazon Canada', inStock: true, price: 39.95,
      ...(productOver || {}),
    },
  };
};

describe('a stale third-party verdict cannot suppress a restock', () => {
  beforeEach(() => {
    calls.cacheReads = 0; calls.liveFetches = 0;
    calls.cachedSeller = null; calls.liveSeller = null; calls.cacheWrites = [];
    calls.cachedAgeMs = 5 * HOUR;
  });

  /**
   * THE REGRESSION THE FIRST VERSION OF THIS FIX INTRODUCED.
   *
   * `fetchAmazonOlidAndSeller` REFUSES a second read of the same ASIN inside its 5-minute per-ASIN
   * cooldown and returns {olid:null, seller:null} — byte-identical to a genuine failure — and that
   * cooldown is armed by the very call that cached the verdict. Treating "a cached verdict exists"
   * as binary therefore turned fail-open into "deliver a scalper listing":
   *
   *   t=0    RESTOCK, cache empty -> paid read -> "Japan Big Mall" -> cached -> suppressed
   *   t=45s  RESTOCK again (45s IS the designed watchlist re-alert cadence)
   *          -> a 45s-old accurate verdict discarded -> re-read refused -> nulls -> ALERT SENT
   *
   * The same null pair comes back when the API key is missing or the budget is paused, so a budget
   * exhaustion would have flipped suppression OFF for every restock at once.
   */
  /**
   * THE LOST RESTOCK — measured in production 2026-09-12 01:15:28Z.
   *
   * B0H7FDBNSB "30th Celebration Knock Out Collection", a client priority ASIN. We read it IN STOCK
   * at $16.99 and suppressed the alert on a cached "ONE AT A TIME CANADA" verdict. Amazon itself
   * held the buy box — a competing monitor alerted it at 01:14:34 — so the cached verdict was
   * simply WRONG and the client lost the restock.
   *
   * It was suppressed because the verdict was RECENT, and the age test trusted recency. That is the
   * wrong question: a seller verdict taken BEFORE a restock is stale by definition however many
   * seconds old it is, because the restock IS the event that changes who holds the buy box. The
   * normal resting state of an out-of-stock ASIN is a marketplace seller holding it, so recency is
   * exactly what made a wrong verdict look trustworthy.
   */
  test('THE LOST RESTOCK: a RECENT verdict cannot suppress a restock', async () => {
    calls.cachedSeller = 'ONE AT A TIME CANADA';
    calls.cachedAgeMs = 60_000;          // one minute old — the case that lost B0H7FDBNSB
    calls.liveSeller = 'Amazon.ca';      // Amazon actually holds the buy box

    const e = event();                   // RESTOCK
    await delivery.enrichEvent(e);

    assert.strictEqual(calls.liveFetches, 1,
      'a restock must re-read regardless of how recent the cached verdict is');
    assert.ok(!e._thirdPartySeller, 'and the real Amazon restock must go out');
  });

  test('THE LOST RESTOCK, re-read refused: fail OPEN and send', async () => {
    // The scraper refuses a second read of the same ASIN inside its 5-minute cooldown, returning
    // the same {null,null} as a genuine failure. Falling back to the pre-restock verdict is what
    // must never happen again: a wasted click beats a suppressed Amazon restock.
    calls.cachedSeller = 'ONE AT A TIME CANADA';
    calls.cachedAgeMs = 60_000;
    calls.liveSeller = null;             // cooldown / budget pause / missing key

    const e = event();
    await delivery.enrichEvent(e);

    assert.ok(!e._thirdPartySeller,
      'an unobtainable re-read must not resurrect a verdict taken before the transition');
  });

  test('PREORDER_LIVE is a stock transition too', async () => {
    calls.cachedSeller = 'ONE AT A TIME CANADA';
    calls.cachedAgeMs = 30_000;
    calls.liveSeller = 'Amazon.ca';

    const e = event({ type: 'PREORDER_LIVE' });
    await delivery.enrichEvent(e);
    assert.strictEqual(calls.liveFetches, 1);
    assert.ok(!e._thirdPartySeller);
  });

  test('a GENUINE third-party restock is STILL suppressed when the live read says so', async () => {
    // Failing open applies only when the verdict cannot be obtained. A fresh live read that says
    // third-party is real evidence and still suppresses.
    calls.cachedSeller = 'ONE AT A TIME CANADA';
    calls.cachedAgeMs = 60_000;
    calls.liveSeller = 'ONE AT A TIME CANADA';

    const e = event();
    await delivery.enrichEvent(e);
    assert.strictEqual(e._thirdPartySeller, true);
    assert.strictEqual(e._sellerFresh, true, 'and it is marked as a live verdict, not a cached one');
  });

  /**
   * These two originally asserted this behaviour for a RESTOCK. Production disproved that on
   * 2026-09-12: trusting a recent verdict on a stock transition suppressed a real Amazon restock
   * (B0H7FDBNSB, above). The age rule is still right for events that are NOT a transition — there
   * the buy box has not necessarily changed, so a verdict younger than the re-read cooldown is the
   * best evidence available and a budget pause must not flip suppression off wholesale.
   */
  test('a RECENT verdict IS trusted on a non-transition event — the cooldown case', async () => {
    calls.cachedSeller = 'Japan Big Mall';
    calls.cachedAgeMs = 45_000;          // 45s old: inside the re-read cooldown
    calls.liveSeller = null;             // a re-read would be refused and return nulls

    const e = event({ type: 'PRICE_CHANGE' });
    await delivery.enrichEvent(e);

    assert.strictEqual(calls.liveFetches, 0,
      'a verdict younger than the cooldown cannot be re-read, so it must not be discarded');
    assert.strictEqual(e._thirdPartySeller, true,
      'no stock transition happened, so the recent verdict still describes the buy box');
  });

  test('a budget pause cannot flip suppression OFF wholesale on non-transition events', async () => {
    // scraper-api returns the same {null,null} when the key is missing or the budget is paused.
    calls.cachedSeller = 'Japan Big Mall';
    calls.cachedAgeMs = 2 * 60_000;
    calls.liveSeller = null;

    const e = event({ type: 'PRICE_CHANGE' });
    await delivery.enrichEvent(e);
    assert.strictEqual(e._thirdPartySeller, true,
      'an unavailable re-read must never be read as "Amazon holds the buy box"');
  });

  test('an OLD verdict is still discarded — the original bug stays fixed', async () => {
    calls.cachedSeller = 'Japan Big Mall';
    calls.cachedAgeMs = 5 * HOUR;
    calls.liveSeller = 'Amazon.ca';

    const e = event();
    await delivery.enrichEvent(e);
    assert.strictEqual(calls.liveFetches, 1);
    assert.ok(!e._thirdPartySeller, 'a 5-hour-old verdict must not suppress a restock');
  });

  test('PRICE_CHANGE and NEW_SKU get the same treatment as RESTOCK', async () => {
    // Measured 2026-09-12: the only two Amazon events in a 40-minute window were PRICE_CHANGE on
    // non-watchlist rows, and BOTH were suppressed on cached verdicts the narrower gate excluded.
    for (const type of ['PRICE_CHANGE', 'NEW_SKU']) {
      calls.liveFetches = 0;
      calls.cachedSeller = 'Japan Big Mall';
      calls.cachedAgeMs = 5 * HOUR;
      calls.liveSeller = 'Amazon.ca';

      const e = event({ type });
      await delivery.enrichEvent(e);
      assert.strictEqual(calls.liveFetches, 1, `${type} must re-read a stale verdict too`);
      assert.ok(!e._thirdPartySeller, `${type} must not be suppressed on a stale verdict`);
    }
  });

  test('THE INCIDENT: cached marketplace seller, Amazon now holds the buy box', async () => {
    calls.cachedSeller = 'Japan Big Mall';            // cached while Amazon was out of stock
    calls.liveSeller = 'Amazon.ca';                   // Amazon retook the buy box on restock

    const e = event();
    await delivery.enrichEvent(e);

    assert.strictEqual(calls.liveFetches, 1, 'a restock must re-read the seller live');
    assert.ok(!e._thirdPartySeller,
      'the month-old verdict must not suppress a restock Amazon itself is fulfilling');
    assert.deepStrictEqual(calls.cacheWrites, ['Amazon.ca'], 'and the cache is refreshed');
  });

  test('a GENUINE third-party restock is still suppressed', async () => {
    calls.cachedSeller = null;
    calls.liveSeller = 'Japan Big Mall';

    const e = event();
    await delivery.enrichEvent(e);

    assert.strictEqual(e._thirdPartySeller, true, 'the client wants sold-by-Amazon only');
    assert.strictEqual(e._seller, 'Japan Big Mall');
    assert.strictEqual(e._sellerFresh, true, 'and the verdict is marked as a live read');
  });

  test('a failed live read fails OPEN — the cached verdict is NOT resurrected', async () => {
    calls.cachedSeller = 'Japan Big Mall';
    calls.liveSeller = null;                          // both fetch paths come back empty

    const e = event();
    await delivery.enrichEvent(e);

    assert.ok(!e._thirdPartySeller,
      'falling back to the stale verdict is exactly what silenced a real restock');
  });

  test('a WATCHLIST alert of any type also re-reads live', async () => {
    calls.cachedSeller = 'Japan Big Mall';
    calls.liveSeller = 'Amazon.ca';

    const e = event({ type: 'PRICE_CHANGE', product: { _watchlist: true } });
    await delivery.enrichEvent(e);

    assert.strictEqual(calls.liveFetches, 1,
      "the client's hand-picked ASINs must never be judged on a stale verdict");
    assert.ok(!e._thirdPartySeller);
  });

  test('a restock with a cached AMAZON verdict adds NO fetch — latency must not be the price', async () => {
    // The first version of this fix bypassed the cache for every restock. That put the enrichment
    // fetch — and its hard 60s abort in fetchAmazonOlidAndSeller — in front of the one event that
    // is actually a race. Measured enrichment tail is 23.25s, and an alert earlier today took 66s
    // on exactly that path. Only a THIRD-PARTY cached verdict can suppress, so only that one is
    // worth re-reading; a stale "Amazon" verdict silences nothing.
    calls.cachedSeller = 'Amazon.ca';
    calls.liveSeller = 'Amazon.ca';

    const e = event();                       // a RESTOCK
    await delivery.enrichEvent(e);

    assert.strictEqual(calls.liveFetches, 0,
      'a harmless cached verdict must not cost the restock a network round trip');
    assert.ok(!e._thirdPartySeller);
  });

  test('a type outside the verify set still uses the cache — no extra credit', async () => {
    // SHIPPING_CHANGE is not in VERIFY_TYPES: it puts no buy link in front of the client, so it is
    // not worth a paid read. This is what bounds the cost of the whole gate.
    calls.cachedSeller = 'Japan Big Mall';
    calls.cachedAgeMs = 5 * HOUR;
    calls.liveSeller = 'Amazon.ca';

    const e = event({ type: 'SHIPPING_CHANGE' });
    await delivery.enrichEvent(e);

    assert.strictEqual(calls.liveFetches, 0, 'no extra credit is spent on low-stakes alerts');
    assert.strictEqual(e._thirdPartySeller, true, 'and the cached verdict still applies there');
  });
});

describe('seller cache TTL', () => {
  test('is hours, not a month — a buy box is not a stable fact', () => {
    const src = require('fs').readFileSync(require.resolve('../src/core/state'), 'utf8');
    const m = src.match(/const SELLER_TTL = ([^;]+);/);
    assert.ok(m, 'SELLER_TTL must still be declared');
    const ttl = Function(`"use strict"; return (${m[1]});`)();
    assert.ok(ttl <= 86400,
      `SELLER_TTL is ${ttl}s — a seller verdict older than a day says nothing about stock now`);
    assert.ok(ttl >= 3600, 'but not so short that every alert pays for a re-read');
  });
});
