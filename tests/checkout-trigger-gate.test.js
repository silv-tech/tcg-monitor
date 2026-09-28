/**
 * When the delivery path is allowed to arm the auto-buyer.
 *
 * A wrong alert costs an apology. A wrong PURCHASE costs money, on the user's own card, and
 * cannot be recalled. So the trigger is published at exactly one point — after the identity
 * gate, the no-stock check and the third-party seller gate have all had their say — and the
 * tests below exist to hold that position rather than the feature itself.
 *
 * Each case here is a real failure this repo has already seen on the ALERT path, re-asked as
 * "what would this have bought?":
 *
 *   B0G8ZLSYWW was stored as a Pokemon card lot and the live listing had become a "Sticky Soccer
 *   Dart Board Game". The identity gate caught it seven minutes after deploy. If the trigger were
 *   published before that gate, the buyer would have bought a dart board.
 *
 *   B0FP9ZZ68C was "Ships from Amazon / Sold by Brick Arsenal LLC" and reached the paid channel
 *   twice. Publishing before the seller gate would have bought from a marketplace reseller.
 *
 * And the invariant that outranks all of it: publishing MUST NOT be able to throw. The call sits
 * under processQueue, where an exception skips markSent() and the alert is retried for ever.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// Same neutering as the identity-gate suite: delivery.js pulls in core/state, and left alone the
// history lookups hold Redis sockets open and a cold cache sends enrichEvent into a real browser.
const state = require('../src/core/state');
state.getRedis = () => null;
state.getRestockHistory = async () => [];
state.getPriceHistory = async () => [];
state.findCrossRetailerMatches = async () => [];
state.getLastCheck = async () => Date.now();
state.getOfferListingId = async () => 'TEST_OLID_0000000000';
state.getSellerCache = async () => 'Amazon.ca';
state.cacheOfferListingId = async () => {};
state.cacheSellerInfo = async () => {};
state.getStoreCategories = async () => null;
state.getActiveCategories = async () => ['default'];
state.denyIdentity = async () => {};

const delivery = require('../src/discord/delivery');
const feed = require('../src/core/checkout-feed');

const realEnrich = delivery.enrichEvent;

beforeEach(() => {
  feed._reset();
  delivery.enrichEvent = async () => {};
  delivery.sendToChannel = async () => true;
  delivery.resolvePaidChannel = () => 'CH_PAID';
  delivery.resolveFreeChannel = () => null;
});

afterEach(() => { delivery.enrichEvent = realEnrich; });

const ev = (over = {}) => ({
  type: 'RESTOCK',
  _detectedAt: Date.now(),
  _seller: 'Amazon.ca',
  product: {
    retailerId: 'amazon', retailer: 'Amazon.ca', sku: 'B0TESTASIN',
    name: 'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
    price: 86.03, inStock: true, category: 'default',
    url: 'https://www.amazon.ca/dp/B0TESTASIN',
  },
  ...over,
});

const triggers = () => feed._since(0);

describe('auto-checkout trigger gate', () => {
  test('a clean Amazon restock publishes exactly one trigger', async () => {
    await delivery.routeEvent(ev({ _offerListingId: 'LIVE_OLID' }), Date.now());
    const t = triggers();
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].asin, 'B0TESTASIN');
    assert.strictEqual(t[0].offerId, 'LIVE_OLID', 'the buy must be pinned to the alert-time offer');
    assert.strictEqual(t[0].price, 86.03);
    assert.strictEqual(t[0].sellerVerified, true);
  });

  test('a WRONG IDENTITY publishes NOTHING — this is the dart board', async () => {
    const e = ev();
    e._identity = { verdict: 'wrong-identity', reason: 'live title out of scope', title: 'Sticky Soccer Dart Board Game' };
    await delivery.routeEvent(e, Date.now());
    assert.deepStrictEqual(triggers(), [], 'a mis-identified listing must never arm the buyer');
  });

  test('a THIRD-PARTY SELLER publishes NOTHING', async () => {
    await delivery.routeEvent(ev({ _thirdPartySeller: true, _seller: 'Brick Arsenal LLC' }), Date.now());
    assert.deepStrictEqual(triggers(), [], 'a marketplace reseller must never arm the buyer');
  });

  test('an UNKNOWN seller still publishes, but flagged unverified', async () => {
    // The alert path fails OPEN on an unknown seller, by client decision. Spending money is a
    // different call, so the fact is handed over rather than the verdict — the extension refuses.
    await delivery.routeEvent(ev({ _seller: null }), Date.now());
    const t = triggers();
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].sellerVerified, false, 'the buyer must be able to tell it was never confirmed');
  });

  test('a PRICE_CHANGE publishes nothing — only a restock arms the buyer', async () => {
    await delivery.routeEvent(ev({ type: 'PRICE_CHANGE', oldValue: 120, newValue: 86.03 }), Date.now());
    assert.deepStrictEqual(triggers(), [], 'a price drop is a human decision');
  });

  test('a non-Amazon restock publishes nothing', async () => {
    const e = ev();
    e.product.retailerId = 'ebgames';
    e.product.retailer = 'EB Games';
    e.product.url = 'https://www.ebgames.ca/x';
    await delivery.routeEvent(e, Date.now());
    assert.deepStrictEqual(triggers(), []);
  });

  test('a scan/test event publishes nothing — admin previews must not buy', async () => {
    await delivery.routeEvent(ev({ _scanTier: 'paid' }), Date.now());
    assert.deepStrictEqual(triggers(), []);
  });

  test('an out-of-stock row publishes nothing', async () => {
    const e = ev();
    e.product.inStock = false;
    await delivery.routeEvent(e, Date.now());
    assert.deepStrictEqual(triggers(), []);
  });

  test('a publish failure NEVER breaks delivery — the alert still sends', async () => {
    // THE invariant: a throw here skips markSent() and the alert retries for ever.
    const realPublish = feed.publish;
    feed.publish = () => { throw new Error('feed exploded'); };
    let sent = 0;
    delivery.sendToChannel = async () => { sent++; return true; };
    try {
      await assert.doesNotReject(() => delivery.routeEvent(ev(), Date.now()));
      assert.ok(sent > 0, 'the Discord alert must still go out when the checkout feed fails');
    } finally {
      feed.publish = realPublish;
    }
  });
});
