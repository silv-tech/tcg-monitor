/**
 * Verifying what an ASIN actually sells, before we alert on it.
 *
 * Driven against REAL trimmed product pages captured on 2026-09-10 (tests/fixtures/dp-*.html), not
 * invented HTML — the three cases are the three that actually occurred:
 *
 *   dp-buyable    B0FPLGBRCT  a genuine in-stock Pokemon listing
 *   dp-drifted    B0D2JGYX3F  stored as "Gardevoir ex League Battle Deck", now a Nex Playground
 *                             games console. This one reached a paying customer's Discord.
 *   dp-no-buybox  B0C75FSW7C  stored inStock:true, but the live page has no add-to-cart, no
 *                             availability block and no offer. Nothing to buy — a class of error
 *                             no identity denylist can catch.
 *
 * THE CRITICAL INVARIANT: only 'wrong-identity' may stop an alert. 'no-stock' and 'inconclusive'
 * must never be collapsed into it.
 *
 * A suppressed restock is unrecoverable — poll-adapter writes the new product state immediately
 * after delivery, so events.js can never re-fire it. If a bot-check or a timeout were treated as a
 * definitive negative, every blocked fetch would silently eat a real restock and look identical to
 * success. So: suppress only when we PARSED a page and it was bad; fire whenever we did not
 * actually get a page. The discriminator is the presence of a productTitle, which every real
 * product page has and no challenge page does.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { verifyAmazonListing, parseListing, parseOffers } = require('../src/utils/amazon-verify');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `dp-${name}.html`), 'utf8');
const BUYABLE = fixture('buyable');
const DRIFTED = fixture('drifted');
const NO_BUYBOX = fixture('no-buybox');

const serve = (html) => async () => html;

describe('a genuine in-stock listing verifies good', () => {
  test('verdict is good', async () => {
    const r = await verifyAmazonListing('B0FPLGBRCT', { fetcher: serve(BUYABLE) });
    assert.strictEqual(r.verdict, 'good', r.reason);
  });

  test('it returns the fields the alert needs', async () => {
    const r = await verifyAmazonListing('B0FPLGBRCT', { fetcher: serve(BUYABLE) });
    assert.match(r.title, /Pok/i);
    assert.strictEqual(r.inStock, true);
    assert.ok(r.olid, 'the one-click add-to-cart links are built from the offer id');
    assert.ok(r.price > 0, `expected a price, got ${r.price}`);
  });
});

describe('a repurposed ASIN verifies wrong-identity — the alert that reached a customer', () => {
  test('the Nex Playground page is rejected', async () => {
    const r = await verifyAmazonListing('B0D2JGYX3F', { fetcher: serve(DRIFTED) });
    assert.strictEqual(r.verdict, 'wrong-identity');
    assert.match(r.reason, /out of scope/);
  });

  test('the live title is reported, so the suppression can be audited', async () => {
    const r = await verifyAmazonListing('B0D2JGYX3F', { fetcher: serve(DRIFTED) });
    assert.ok(r.title && r.title.length > 3,
      'a suppression nobody can explain later is one nobody will trust');
  });
});

describe('a listing with nothing to buy verifies no-stock, NOT wrong-identity', () => {
  test('no buy box and no offer id is reported as a stock answer', async () => {
    const r = await verifyAmazonListing('B0C75FSW7C', { fetcher: serve(NO_BUYBOX) });
    assert.strictEqual(r.verdict, 'no-stock',
      'the right product with nothing buyable is transient — a caller must never denylist on it');
    assert.match(r.reason, /nothing to buy/);
  });

  test('the page WAS parsed — that is what makes it a negative rather than silence', async () => {
    const p = parseListing(NO_BUYBOX);
    assert.strictEqual(p.parsed, true);
    assert.ok(p.title, 'a real page always has a title');
    assert.strictEqual(p.inStock, false);
  });
});

describe('we never suppress on a page we did not actually read', () => {
  const inconclusive = [
    ['a bot-check page', '<html><body>Enter the characters you see below. Sorry, we just need to make sure you are not a robot.</body></html>'],
    ['an empty body', ''],
    ['a truncated response', '<html><body><div id="a-page">'],
    ['a 5xx error page', '<html><head><title>500 Internal Server Error</title></head><body>oops</body></html>'],
    ['null (budget refused the fetch)', null],
  ];

  for (const [label, body] of inconclusive) {
    test(`${label} is inconclusive, not bad`, async () => {
      const r = await verifyAmazonListing('B0TEST0001', { fetcher: serve(body) });
      assert.strictEqual(r.verdict, 'inconclusive',
        'treating this as bad would silently eat a real restock, unrecoverably');
    });
  }

  test('a fetcher that throws is inconclusive', async () => {
    const r = await verifyAmazonListing('B0TEST0001', {
      fetcher: async () => { throw new Error('ECONNRESET'); },
    });
    assert.strictEqual(r.verdict, 'inconclusive');
  });

  test('a hanging fetcher times out and fails open', async () => {
    const started = Date.now();
    const r = await verifyAmazonListing('B0TEST0001', {
      fetcher: () => new Promise(() => {}), timeoutMs: 300,
    });
    assert.strictEqual(r.verdict, 'inconclusive');
    assert.ok(Date.now() - started < 3000, 'it must not hold the alert past its timeout');
  });

  test('no fetcher at all is inconclusive rather than an exception', async () => {
    assert.strictEqual((await verifyAmazonListing('B0TEST0001', {})).verdict, 'inconclusive');
  });

  test('it never throws, whatever it is handed', async () => {
    for (const bad of [undefined, 123, {}, [], Buffer.from('x')]) {
      const r = await verifyAmazonListing('B0TEST0001', { fetcher: async () => bad });
      assert.strictEqual(r.verdict, 'inconclusive', `threw or misjudged on ${typeof bad}`);
    }
  });
});

describe('the parser reads the real pages correctly', () => {
  test('the buyable page yields an offer id', () => {
    assert.ok(parseListing(BUYABLE).olid);
  });

  test('the drifted page still parses — it is a real page, just the wrong product', () => {
    const p = parseListing(DRIFTED);
    assert.strictEqual(p.parsed, true,
      'if this failed to parse we would fire the alert instead of suppressing it');
  });

  test('a page with no title is not parsed, whatever else it contains', () => {
    const p = parseListing('<html><body><span class="a-offscreen">$49.99</span>'
      + '<span id="add-to-cart-button"></span></body></html>');
    assert.strictEqual(p.parsed, false,
      'price and a cart button are not evidence we read the right page');
  });
});

/**
 * The cheap lane: ScraperAPI's structured offers payload (~1 credit, ~2KB JSON) instead of a
 * ~18-credit 1.2MB product page. Fixtures are real payloads captured 2026-09-10.
 *
 * The rule that matters is STOCK = THE PINNED OFFER HAS A PRICE, not "any listing has a price".
 * B0C75FSW7C carries four priced marketplace listings while its pinned offer has none, and its
 * product page shows no add-to-cart at all. An "any listing" rule calls it in stock — and it is
 * already our known false-in-stock row, so that rule would assert the bug instead of catching it.
 */
describe('the structured offers lane', () => {
  const offers = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `offers-${name}.json`), 'utf8');
  const BUYABLE_J = offers('buyable');
  const NO_PRICE_J = offers('no-price');
  const WATCHLIST_J = offers('watchlist-oos');

  test('a pinned priced offer is in stock', async () => {
    const r = await verifyAmazonListing('B0FPLGBRCT', { fetcher: serve(BUYABLE_J) });
    assert.strictEqual(r.verdict, 'good', r.reason);
    assert.strictEqual(r.inStock, true);
    assert.strictEqual(r.price, 86.03);
    assert.match(r.title, /Pok/i);
  });

  test('an UNPRICED pinned offer is not in stock, even with priced marketplace listings', async () => {
    const r = await verifyAmazonListing('B0C75FSW7C', { fetcher: serve(NO_PRICE_J) });
    assert.strictEqual(r.verdict, 'no-stock',
      'four listings carry prices but nothing is featured — the product page has no add-to-cart');
    assert.match(r.reason, /nothing to buy/);
    assert.strictEqual(r.inStock, false);
  });

  test('the cheapest marketplace price is reported as context, not as the buy box', async () => {
    const r = await parseOffers(NO_PRICE_J);
    assert.strictEqual(r.price, 119.89, 'useful in a log line');
    assert.strictEqual(r.inStock, false, 'but it must never make the product look buyable');
  });

  test('a search-invisible watchlist ASIN is readable, and correctly not buyable', async () => {
    const r = await verifyAmazonListing('B0H77W4411', { fetcher: serve(WATCHLIST_J) });
    assert.strictEqual(r.verdict, 'no-stock');
    assert.match(r.title, /30th Celebration Poster Collection/,
      'this endpoint is the only way to see the ASINs search cannot reach');
  });

  test('a payload with no item.name is inconclusive, never bad', async () => {
    for (const body of ['{}', '{"listings":[]}', '{"item":{}}', '[]', 'not json at all']) {
      const r = await verifyAmazonListing('B0TEST0001', { fetcher: serve(body) });
      assert.strictEqual(r.verdict, 'inconclusive', `wrong verdict for ${body}`);
    }
  });

  test('JSON is routed to the offers parser and HTML to the page parser', async () => {
    const j = await verifyAmazonListing('B0FPLGBRCT', { fetcher: serve(BUYABLE_J) });
    const h = await verifyAmazonListing('B0FPLGBRCT', { fetcher: serve(BUYABLE) });
    assert.strictEqual(j.verdict, 'good');
    assert.strictEqual(h.verdict, 'good');
    assert.ok(h.olid, 'only the page carries an offer id');
    assert.strictEqual(j.olid, null, 'the offers payload has none — checked the whole tree');
  });

  test('parseOffers never throws, whatever it is handed', () => {
    for (const bad of [null, undefined, 42, '', '{', [], {}, { item: null }]) {
      assert.strictEqual(parseOffers(bad).parsed, false);
    }
  });

  test('with nothing flagged pinned it falls back to the top listing, not to "in stock"', () => {
    const noPinned = JSON.stringify({
      item: { name: 'Pokemon TCG: Test Booster Box' },
      listings: [{ price: 49.99, seller_name: 'X' }, { price: 59.99, seller_name: 'Y' }],
    });
    assert.strictEqual(parseOffers(noPinned).inStock, true, 'top offer priced => buyable');

    const noPinnedUnpriced = JSON.stringify({
      item: { name: 'Pokemon TCG: Test Booster Box' },
      listings: [{ seller_name: 'X' }, { price: 59.99, seller_name: 'Y' }],
    });
    assert.strictEqual(parseOffers(noPinnedUnpriced).inStock, false,
      'shape drift must degrade to reading the top offer, never to asserting stock');
  });
});

describe('the two negatives are distinguishable without reading the reason string', () => {
  test('a wrong product and an out-of-stock product get DIFFERENT verdicts', async () => {
    const wrong = await verifyAmazonListing('B0D2JGYX3F', { fetcher: serve(DRIFTED) });
    const oos = await verifyAmazonListing('B0C75FSW7C', { fetcher: serve(NO_BUYBOX) });
    assert.notStrictEqual(wrong.verdict, oos.verdict,
      'collapsing these lets a sold-out restock be treated as a repurposed ASIN and denylisted');
  });

  test("no verdict is the literal string 'bad' any more", async () => {
    // A caller written against the old vocabulary must fail loudly rather than silently stop
    // suppressing (or silently start suppressing the wrong thing).
    for (const body of [DRIFTED, NO_BUYBOX, BUYABLE]) {
      const r = await verifyAmazonListing('B0X', { fetcher: serve(body) });
      assert.notStrictEqual(r.verdict, 'bad');
      assert.ok(['good', 'wrong-identity', 'no-stock', 'inconclusive'].includes(r.verdict),
        `unexpected verdict: ${r.verdict}`);
    }
  });
});
