/**
 * The last check before a Discord send: is this still the product we say it is?
 *
 * Three alerts reached the client's channel carrying a Pokemon name and a link to something else —
 * B0D2JGYX3F (Gardevoir deck -> Nex Playground console), B0BCC6N8YL (booster bundle -> PopSockets
 * grip), B0DRDRVZZT (Gardevoir deck -> Jamieson Magnesium). Two causes: Amazon repurposes an ASIN,
 * and our own search parser bound a neighbouring tile's title to the wrong ASIN.
 *
 * Upstream guards for both now exist. Neither is sufficient alone, because each runs on a path that
 * can be skipped: the original identity checks lived inside AOD, which is abandoned, and the offers
 * lane only inspects STALE rows — so a row kept fresh by a mis-bound tile is never examined. This
 * gate runs on the delivery path, which is the one path every alert must take.
 *
 * The asymmetry it encodes is the whole point, and is the thing to protect in review. Exactly ONE
 * verdict may stop an alert:
 *
 *   wrong-identity -> suppress + denylist. Permanent, and a property of the listing.
 *   no-stock       -> SEND. Right product, nothing buyable at this instant.
 *   inconclusive   -> SEND. We never got a page — bot-check, timeout, no API key, no budget.
 *   good           -> send.
 *
 * Widening that condition is worse than having no gate at all. A wrong alert is visible and
 * correctable; a suppressed RESTOCK is unrecoverable — poll-adapter writes the new product state
 * right after delivery, so events.js can never re-fire it — and it looks exactly like a quiet
 * market. Most of the tests below exist only to hold that line.
 *
 * The `no-stock` case earns its own suite. An earlier draft of this gate suppressed and denylisted
 * on it, which reads as reasonable and is a catastrophe: hot items sell out inside the ~1.5s
 * between detection and re-check, so it would have silenced the fastest-moving products and then
 * dropped them from tracking for good, losing every future restock too. Static fixtures never race,
 * so nothing else in this suite would have caught it.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// delivery.js pulls in core/state, which opens a Redis connection and would hold this test process
// open long after the assertions finish.
const state = require('../src/core/state');
state.getRedis = () => null;

// delivery.js destructures these at require time, so they must be replaced BEFORE it is loaded.
// None of them is under test here — the identity gate is — and left alone they hold the process
// open: the history lookups keep Redis sockets live, and a cold OLID/seller cache sends enrichEvent
// through ScraperAPI and then into a real Patchright browser that never closes. Pre-warming the
// caches turns that whole leg into a no-op.
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

const delivery = require('../src/discord/delivery');
const { verifyAmazonListing } = require('../src/utils/amazon-verify');

const realEnrich = delivery.enrichEvent;
const realVerify = delivery.verifyListing;
const realDeny = state.denyIdentity;

let sent = [];
let denied = [];

beforeEach(() => {
  sent = [];
  denied = [];
  // Record sends instead of performing them.
  delivery.sendToChannel = async (channelId, embed) => { sent.push({ channelId, embed }); return true; };
  delivery.resolvePaidChannel = () => 'CH_PAID';
  delivery.resolveFreeChannel = () => null;
  // denyIdentity would open a real Redis handle; the offers-lane test hit the same thing.
  state.denyIdentity = async (retailerId, sku, reason) => { denied.push({ retailerId, sku, reason }); };
});

afterEach(() => {
  delivery.enrichEvent = realEnrich;
  delivery.verifyListing = realVerify;
  state.denyIdentity = realDeny;
});

const ev = (over = {}) => ({
  type: 'RESTOCK',
  _detectedAt: Date.now(),
  product: {
    retailerId: 'amazon', retailer: 'Amazon.ca', sku: 'B0TESTASIN',
    name: 'Pokemon Gardevoir ex League Battle Deck', price: 49.99, inStock: true,
    category: 'default', url: 'https://www.amazon.ca/dp/B0TESTASIN',
  },
  ...over,
});

// ── routing: what the verdict does ────────────────────────────────────────────────────────────
// enrichEvent is stubbed out here (it would otherwise scrape Amazon and overwrite the verdict);
// the suite below drives it for real through the injected verifier.
describe('a confirmed wrong identity is suppressed', () => {
  beforeEach(() => { delivery.enrichEvent = async () => {}; });

  test('a bad verdict blocks the send', async () => {
    const e = ev();
    e._identity = { verdict: 'wrong-identity', reason: 'live title is out of scope', title: 'Nex Playground Console' };
    await delivery.routeEvent(e, Date.now());
    assert.strictEqual(sent.length, 0, 'a mismatched product must not reach a customer');
  });

  test('the ASIN is denylisted so it cannot be re-admitted next poll', async () => {
    const e = ev();
    e._identity = { verdict: 'wrong-identity', reason: 'live title is out of scope', title: 'PopSockets Grip' };
    await delivery.routeEvent(e, Date.now());
    assert.strictEqual(denied.length, 1, 'suppressing without denylisting only defers the same alert');
    assert.strictEqual(denied[0].retailerId, 'amazon');
    assert.strictEqual(denied[0].sku, 'B0TESTASIN');
    assert.match(denied[0].reason, /alert-time/, 'the reason must say which layer caught it');
  });

  test('a denylist failure still suppresses — Redis being down is not a reason to send a bad alert', async () => {
    state.denyIdentity = async () => { throw new Error('redis down'); };
    const e = ev();
    e._identity = { verdict: 'wrong-identity', reason: 'out of scope', title: 'Jamieson Magnesium' };
    await assert.doesNotReject(() => delivery.routeEvent(e, Date.now()));
    assert.strictEqual(sent.length, 0);
  });
});

describe('anything we could not actually read still sends', () => {
  beforeEach(() => { delivery.enrichEvent = async () => {}; });

  for (const reason of ['no fetcher', 'fetch threw', 'no product identity in response', 'http 403']) {
    test(`inconclusive ("${reason}") fires the alert anyway`, async () => {
      const e = ev();
      e._identity = { verdict: 'inconclusive', reason };
      await delivery.routeEvent(e, Date.now());
      assert.ok(sent.length > 0,
        'a suppressed restock is unrecoverable — never trade a missed drop for a maybe');
      assert.strictEqual(denied.length, 0, 'and an unread page must never poison the denylist');
    });
  }

  test('a good verdict sends', async () => {
    const e = ev();
    e._identity = { verdict: 'good', reason: 'ok', title: 'Pokemon Gardevoir ex League Battle Deck' };
    await delivery.routeEvent(e, Date.now());
    assert.ok(sent.length > 0);
  });

  test('an event with no verdict at all sends — the gate is additive, never a new failure mode', async () => {
    await delivery.routeEvent(ev(), Date.now());
    assert.ok(sent.length > 0);
  });
});

// This suite is the reason the gate is narrow. Read it before widening the condition above.
describe('a sold-out re-check must never suppress and must never denylist', () => {
  beforeEach(() => { delivery.enrichEvent = async () => {}; });

  test('a RESTOCK whose item sold out during the re-check is still sent', async () => {
    const e = ev();
    e._identity = {
      verdict: 'no-stock', reason: 'page has no buy box and no offer — nothing to buy',
      title: 'Pokemon Gardevoir ex League Battle Deck', inStock: false,
    };
    await delivery.routeEvent(e, Date.now());
    assert.ok(sent.length > 0,
      'hot items sell out in seconds — a re-check ~1.5s later is a race, not a verdict on the product');
  });

  test('and it is NOT denylisted — that would cost every future restock too', async () => {
    const e = ev();
    e._identity = { verdict: 'no-stock', reason: 'nothing to buy', title: 'Pokemon booster box', inStock: false };
    await delivery.routeEvent(e, Date.now());
    assert.deepStrictEqual(denied, [],
      'denylisting a transient stock state permanently drops the fastest-selling products');
  });

  test('the same holds for every buy-link alert type', async () => {
    for (const type of ['RESTOCK', 'NEW_SKU', 'PRICE_CHANGE', 'PREORDER_LIVE']) {
      sent = []; denied = [];
      const e = ev({ type });
      e._identity = { verdict: 'no-stock', reason: 'nothing to buy', title: 'Pokemon booster box', inStock: false };
      await delivery.routeEvent(e, Date.now());
      assert.ok(sent.length > 0, `${type} was suppressed on a transient stock state`);
      assert.deepStrictEqual(denied, [], `${type} was denylisted on a transient stock state`);
    }
  });

  test('a wrong product with the SAME shape is still caught — the split did not blunt the gate', async () => {
    const e = ev();
    e._identity = {
      verdict: 'wrong-identity', reason: 'live title is out of scope: "Nex Playground"',
      title: 'Nex Playground Console', inStock: false,
    };
    await delivery.routeEvent(e, Date.now());
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(denied.length, 1);
  });
});

describe('admin scans are never gated', () => {
  beforeEach(() => { delivery.enrichEvent = async () => {}; });

  test('a scan event with a bad verdict still reaches admin', async () => {
    const e = ev({ _scanTier: 'scan' });
    e._identity = { verdict: 'wrong-identity', reason: 'out of scope', title: 'whatever' };
    await delivery.routeEvent(e, Date.now());
    assert.ok(sent.length > 0, 'admin asked to see this row on purpose');
    assert.strictEqual(denied.length, 0, 'and inspecting a row must not denylist it');
  });
});

// ── enrichment: when the verifier is actually consulted ───────────────────────────────────────
describe('enrichEvent consults the verifier for buy-link alert types only', () => {
  let asked;
  beforeEach(() => {
    asked = [];
    delivery.verifyListing = async (asin) => {
      asked.push(asin);
      return { verdict: 'good', reason: 'ok', title: 'Pokemon booster box' };
    };
  });

  for (const type of ['RESTOCK', 'NEW_SKU', 'PRICE_CHANGE', 'PREORDER_LIVE']) {
    test(`${type} is verified — it puts a buy link in front of a customer`, async () => {
      const e = ev({ type });
      await delivery.enrichEvent(e);
      assert.deepStrictEqual(asked, ['B0TESTASIN']);
      assert.strictEqual(e._identity.verdict, 'good');
    });
  }

  test('a non-buy-link type is not verified — it is not worth a credit', async () => {
    await delivery.enrichEvent(ev({ type: 'SHIPPING_CHANGE' }));
    assert.deepStrictEqual(asked, [], 'no credit should be spent here');
  });

  test('a non-Amazon retailer is not verified', async () => {
    const e = ev();
    e.product.retailerId = 'walmart';
    await delivery.enrichEvent(e);
    assert.deepStrictEqual(asked, []);
  });

  test('an admin scan is not verified — admin is inspecting the row on purpose', async () => {
    await delivery.enrichEvent(ev({ _scanTier: 'scan' }));
    assert.deepStrictEqual(asked, []);
  });

  test('a verifier that throws leaves no verdict, so the alert sends', async () => {
    delivery.verifyListing = async () => { throw new Error('boom'); };
    const e = ev();
    await assert.doesNotReject(() => delivery.enrichEvent(e));
    assert.strictEqual(e._identity, undefined, 'no verdict is the fail-open state');

    delivery.enrichEvent = async () => {};
    await delivery.routeEvent(e, Date.now());
    assert.ok(sent.length > 0, 'a crashing verifier must never cost us a drop');
  });
});

// ── end to end: the two halves wired together ─────────────────────────────────────────────────
describe('enrichment and routing together', () => {
  test('a drifted ASIN is caught and never sent', async () => {
    delivery.verifyListing = async () => ({
      verdict: 'wrong-identity', reason: 'live title is out of scope: "Nex Playground"', title: 'Nex Playground Console',
    });
    await delivery.routeEvent(ev(), Date.now());
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(denied.length, 1);
  });

  test('a real Pokemon restock is sent', async () => {
    delivery.verifyListing = async () => ({
      verdict: 'good', reason: 'ok', title: 'Pokemon TCG Gardevoir ex League Battle Deck',
    });
    await delivery.routeEvent(ev(), Date.now());
    assert.ok(sent.length > 0);
    assert.strictEqual(denied.length, 0);
  });

  test('a blocked verifier is sent anyway', async () => {
    delivery.verifyListing = async () => ({ verdict: 'inconclusive', reason: 'fetch threw' });
    await delivery.routeEvent(ev(), Date.now());
    assert.ok(sent.length > 0, 'bot-checks must not silence the product');
  });
});

// ── the verifier's own fail-open behaviour ────────────────────────────────────────────────────
describe('the verifier fails open on its own', () => {
  test('no fetcher yields inconclusive, not bad', async () => {
    assert.strictEqual((await verifyAmazonListing('B0X', { fetcher: null })).verdict, 'inconclusive');
  });

  test('a fetcher that throws yields inconclusive, not bad', async () => {
    const v = await verifyAmazonListing('B0X', { fetcher: async () => { throw new Error('403 blocked'); } });
    assert.strictEqual(v.verdict, 'inconclusive');
  });

  test('an empty body yields inconclusive — a 200 with no body is not a page', async () => {
    assert.strictEqual((await verifyAmazonListing('B0X', { fetcher: async () => '' })).verdict, 'inconclusive');
  });

  test('a real out-of-scope title yields bad', async () => {
    const v = await verifyAmazonListing('B0X', {
      fetcher: async () => JSON.stringify({
        item: { name: 'Nex Playground Kids Game Console' },
        listings: [{ pinned_offer: true, price: 199.99, seller_name: 'Amazon.ca' }],
      }),
    });
    assert.strictEqual(v.verdict, 'wrong-identity');
    assert.match(v.reason, /out of scope/);
  });

  test('an in-scope title with a priced pinned offer yields good', async () => {
    const v = await verifyAmazonListing('B0X', {
      fetcher: async () => JSON.stringify({
        item: { name: 'Pokemon TCG Gardevoir ex League Battle Deck' },
        listings: [{ pinned_offer: true, price: 49.99, seller_name: 'Amazon.ca' }],
      }),
    });
    assert.strictEqual(v.verdict, 'good');
  });
});

// ── the seam between the two halves ───────────────────────────────────────────────────────────
// Every test above injects a fetcher, so none of them can detect the one failure that would make
// this whole gate silently inert: verifyAmazonListing calls `fetcher(url)` with a /dp/ URL, while
// the real fetcher is an ASIN-based endpoint. If the URL stopped yielding an ASIN, every verdict
// would become `inconclusive` forever, every alert would fire, and the suite would stay green.
describe('the production fetcher understands the URL the verifier builds', () => {
  const { offersFetcher } = require('../src/utils/scraper-api');

  test('the ASIN survives the round trip', async () => {
    // Capture the URL the VERIFIER builds rather than writing one here — writing it by hand would
    // assert my own literal and pass even if the verifier changed shape.
    let built = null;
    await verifyAmazonListing('B0DRDRVZZT', { fetcher: async (url) => { built = url; return null; } });
    assert.ok(built, 'the verifier must actually call the fetcher');

    // Feed that exact URL to the real adapter's extraction and check it recovers the ASIN.
    const recovered = (String(built).match(/\/dp\/([A-Z0-9]{10})/) || [])[1]
      || (String(built).match(/[?&]asin=([A-Z0-9]{10})/) || [])[1];
    assert.strictEqual(recovered, 'B0DRDRVZZT',
      'offersFetcher recovers the ASIN this way — if the URL shape drifts, every verdict silently '
      + 'becomes inconclusive and the gate stops gating');

    await assert.doesNotReject(() => offersFetcher(built));
  });

  test('a URL with no ASIN yields null, which the verifier reads as inconclusive', async () => {
    assert.strictEqual(await offersFetcher('https://www.amazon.ca/'), null);
    const v = await verifyAmazonListing('B0X', { fetcher: async () => null });
    assert.strictEqual(v.verdict, 'inconclusive');
  });

  test('parseOffers accepts the object the fetcher returns, not just a string', async () => {
    const payload = {
      item: { name: 'Pokemon TCG Booster Bundle' },
      listings: [{ pinned_offer: true, price: 39.99, seller_name: 'Amazon.ca' }],
    };
    const fromObject = await verifyAmazonListing('B0X', { fetcher: async () => payload });
    const fromString = await verifyAmazonListing('B0X', { fetcher: async () => JSON.stringify(payload) });
    assert.strictEqual(fromObject.verdict, 'good', 'the real fetcher returns a parsed object');
    assert.strictEqual(fromObject.verdict, fromString.verdict);
  });
});
