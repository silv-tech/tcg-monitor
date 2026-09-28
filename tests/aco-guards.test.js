/**
 * The guards that decide whether the auto-buyer spends money.
 *
 * The governing rule, and the thing to protect in review:
 *
 *   REFUSING TO BUY IS ALWAYS THE CHEAP OUTCOME. A missed purchase costs a restock. A wrong
 *   purchase costs money on a real card and cannot be recalled. So every ambiguous case must
 *   resolve to "don't" — the OPPOSITE of the monitor's alert rule, where inconclusive means send.
 *   The costs invert, so the defaults invert with them.
 *
 * Most of these exist because a review of the first draft found the guards failing OPEN:
 * an unreadable price skipped the ceiling, an unreadable line count reported 1, and a missing
 * timestamp skipped the staleness check. Each is pinned below.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const g = require('../amazon-aco-extension/guards');

const TRIGGER = { asin: 'B0TESTASIN', offerId: 'OLID123', price: 86.03, sellerVerified: true, at: Date.now() };
const ARMED = { asin: 'B0TESTASIN', quantity: 1, maxPrice: 100 };

describe('decide', () => {
  test('a clean trigger on an armed item buys', () => {
    assert.deepStrictEqual(g.decide(TRIGGER, ARMED), { buy: true, reason: 'ok' });
  });

  test('the kill switch outranks a perfectly good trigger', () => {
    const d = g.decide(TRIGGER, ARMED, { armedGlobally: false });
    assert.strictEqual(d.buy, false);
    assert.strictEqual(d.reason, 'disarmed');
  });

  test('a different ASIN never buys', () => {
    assert.strictEqual(g.decide({ ...TRIGGER, asin: 'B0OTHER0000' }, ARMED).buy, false);
  });

  test('ASIN matching ignores case and whitespace but nothing else', () => {
    assert.strictEqual(g.decide({ ...TRIGGER, asin: ' b0testasin ' }, ARMED).buy, true);
    assert.strictEqual(g.decide({ ...TRIGGER, asin: 'B0TESTASI' }, ARMED).buy, false, 'a prefix is not a match');
  });

  test('a stale trigger never buys', () => {
    const d = g.decide({ ...TRIGGER, at: Date.now() - 5 * 60 * 1000 }, ARMED);
    assert.strictEqual(d.buy, false);
    assert.match(d.reason, /stale/);
  });

  test('a trigger with NO usable timestamp is refused, not waved through', () => {
    // Treating an unreadable `at` as "not stale" removes the only thing standing between the
    // server's whole replay buffer and the card.
    for (const bad of [undefined, null, 'yesterday', NaN, {}]) {
      const d = g.decide({ ...TRIGGER, at: bad }, ARMED);
      assert.strictEqual(d.buy, false, `at=${JSON.stringify(bad)} must refuse`);
      assert.match(d.reason, /timestamp/);
    }
  });

  test('an UNVERIFIED seller refuses by default', () => {
    const d = g.decide({ ...TRIGGER, sellerVerified: false }, ARMED);
    assert.strictEqual(d.buy, false);
    assert.strictEqual(d.reason, 'seller not verified');
  });

  test('an unverified seller CAN be opted into, per item', () => {
    assert.strictEqual(
      g.decide({ ...TRIGGER, sellerVerified: false }, { ...ARMED, allowUnverifiedSeller: true }).buy, true);
  });

  test('sellerVerified must be exactly true — no truthy strings', () => {
    assert.strictEqual(g.decide({ ...TRIGGER, sellerVerified: 'yes' }, ARMED).buy, false);
    assert.strictEqual(g.decide({ ...TRIGGER, sellerVerified: 1 }, ARMED).buy, false);
  });

  test('NO max price is an open chequebook — refuse', () => {
    for (const bad of [undefined, null, 0, -5, 'lots', NaN]) {
      assert.strictEqual(g.decide(TRIGGER, { ...ARMED, maxPrice: bad }).buy, false, `maxPrice ${bad}`);
    }
  });

  test('over the ceiling never buys — the scalper relist case', () => {
    const d = g.decide({ ...TRIGGER, price: 400 }, ARMED);
    assert.strictEqual(d.buy, false);
    assert.match(d.reason, /over max/);
  });

  test('exactly at the ceiling buys', () => {
    assert.strictEqual(g.decide({ ...TRIGGER, price: 100 }, ARMED).buy, true);
  });

  test('a MISSING price refuses — absence is not permission', () => {
    for (const bad of [undefined, null, 0, -1, 'free']) {
      assert.strictEqual(g.decide({ ...TRIGGER, price: bad }, ARMED).buy, false, `price ${bad}`);
    }
  });

  test('garbage in never buys and never throws', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}]) {
      assert.doesNotThrow(() => g.decide(bad, ARMED));
      assert.strictEqual(g.decide(bad, ARMED).buy, false);
      assert.strictEqual(g.decide(TRIGGER, bad).buy, false);
    }
  });
});

describe('buyNowUrl', () => {
  // An OLID is base64 and carries + / =. Raw in a query string, `+` decodes to a SPACE and
  // Amazon resolves nothing, then falls back to the buy box — the exact defect offeringID
  // exists to prevent.
  test('percent-encodes a RAW token from our own feed', () => {
    assert.strictEqual(
      g.buyNowUrl('B0H77VZBX4', 'N+3cj/DHlTg8lwmzU=', 1),
      'https://www.amazon.ca/checkout/entry/buynow?asin=B0H77VZBX4&offeringID=N%2B3cj%2FDHlTg8lwmzU%3D&quantity=1');
  });

  test('passes through a token ALREADY encoded, e.g. pasted from a Discord alert', () => {
    // Verified against a live Zephyr/PokeNotify alert: `N%2B3cj…%2F9tbU…%3D`. Encoding it again
    // would turn %2B into %252B and break it just as thoroughly as not encoding at all.
    assert.strictEqual(
      g.buyNowUrl('B0H77VZBX4', 'N%2B3cj%2FDHlTg8lwmzU%3D', 1),
      'https://www.amazon.ca/checkout/entry/buynow?asin=B0H77VZBX4&offeringID=N%2B3cj%2FDHlTg8lwmzU%3D&quantity=1');
  });

  test('both forms of the same token produce the SAME url', () => {
    assert.strictEqual(
      g.buyNowUrl('B0H77VZBX4', 'N+3cj/DHlTg8lwmzU=', 2),
      g.buyNowUrl('B0H77VZBX4', 'N%2B3cj%2FDHlTg8lwmzU%3D', 2));
  });

  test('param order matches the shipping competitor build', () => {
    assert.match(g.buyNowUrl('B0TESTASIN', 'abc', 1), /\?asin=[^&]+&offeringID=[^&]+&quantity=1$/);
  });

  test('REFUSES to build a url with no offer id', () => {
    // A bare Buy Now entry lets Amazon sell whatever sits in the buy box. The caller opens the
    // product page instead and leaves the decision to a human.
    assert.strictEqual(g.buyNowUrl('B0TESTASIN', null, 1), null);
    assert.strictEqual(g.buyNowUrl('B0TESTASIN', '   ', 1), null);
  });
});

describe('clampQuantity', () => {
  test('clamps to Amazon\'s limit and never below one', () => {
    assert.strictEqual(g.clampQuantity(100), 12, 'a fat-fingered 100 must not buy 100');
    assert.strictEqual(g.clampQuantity(0), 1);
    assert.strictEqual(g.clampQuantity(-3), 1);
    assert.strictEqual(g.clampQuantity('abc'), 1);
    assert.strictEqual(g.clampQuantity(2.9), 2);
    assert.strictEqual(g.clampQuantity(3), 3);
  });
});

describe('pageStateOf', () => {
  test('recognises every checkout state we act on', () => {
    const s = g.pageStateOf;
    assert.strictEqual(s('https://www.amazon.ca/checkout/p/abc123/spc'), 'spc');
    assert.strictEqual(s('https://www.amazon.ca/checkout/p/abc123/itemselect'), 'itemselect');
    assert.strictEqual(s('https://www.amazon.ca/checkout/entry/buynow?asin=x'), 'entry');
    assert.strictEqual(s('https://www.amazon.ca/checkout/entry/oos'), 'out_of_stock');
    assert.strictEqual(s('https://www.amazon.ca/checkout/entry/cart'), 'cart');
    assert.strictEqual(s('https://www.amazon.ca/gp/buy/thankyou/'), 'thankyou');
    assert.strictEqual(s('https://www.amazon.ca/checkout/p/abc123/thankyou'), 'thankyou');
    assert.strictEqual(s('https://www.amazon.ca/ap/signin?x=1'), 'signin');
    assert.strictEqual(s('https://www.amazon.ca/dp/B0TESTASIN'), 'product');
    assert.strictEqual(s('https://www.amazon.ca/something/else'), 'unknown');
    assert.strictEqual(s('not a url'), 'unknown');
  });

  test('the spc match is exact — a lookalike path is not the checkout', () => {
    assert.notStrictEqual(g.pageStateOf('https://www.amazon.ca/checkout/p/a/spc/extra'), 'spc');
  });

  test('itemselect rewrites to the real checkout', () => {
    assert.strictEqual(
      g.itemSelectToSpc('https://www.amazon.ca/checkout/p/abc/itemselect?x=1'),
      'https://www.amazon.ca/checkout/p/abc/spc?referrer=spc');
    assert.strictEqual(g.itemSelectToSpc('https://www.amazon.ca/checkout/p/abc/spc'), null);
  });
});

describe('verifyCheckoutPage', () => {
  const intent = { asin: 'B0TESTASIN', maxPrice: 100, quantity: 1, offerPinned: true };

  test('the right product at a sane total passes', () => {
    assert.strictEqual(
      g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: 97.21 }, intent).ok, true);
  });

  test('a DIFFERENT ASIN on the checkout page is refused', () => {
    const r = g.verifyCheckoutPage({ asin: 'B0DARTBOARD', lineItemCount: 1, price: 20 }, intent);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /expected B0TESTASIN/);
  });

  test('an unreadable ASIN is refused — inconclusive means DO NOT BUY', () => {
    assert.strictEqual(g.verifyCheckoutPage({ asin: '', lineItemCount: 1, price: 10 }, intent).ok, false);
  });

  test('an unreadable LINE COUNT is refused, not treated as one item', () => {
    // Returning 1 on no match means the guard passes on exactly the pages it failed to parse.
    const r = g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: null, price: 50 }, intent);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /line items/);
  });

  test('more than one line item is refused — never buy the cart', () => {
    const r = g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 4, price: 86 }, intent);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /refusing to buy a cart/);
  });

  test('the ceiling allows for quantity and tax, or it would refuse everything', () => {
    // $54.99 under a $59.99 ceiling becomes $62.14 after 13% HST. A naive compare rejects a
    // correctly-armed item for ever, and users "fix" that by doubling the ceiling — which
    // disables the scalper protection at the trigger level.
    const i = { asin: 'B0TESTASIN', maxPrice: 59.99, quantity: 1, offerPinned: true };
    assert.strictEqual(g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: 62.14 }, i).ok, true);
  });

  test('a genuinely inflated total is still refused', () => {
    const r = g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: 400 }, intent);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /over/);
  });

  test('quantity scales the ceiling', () => {
    const i = { asin: 'B0TESTASIN', maxPrice: 50, quantity: 3, offerPinned: true };
    assert.strictEqual(g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: 170 }, i).ok, true);
    assert.strictEqual(g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: 600 }, i).ok, false);
  });

  test('an unreadable total passes ONLY when the offer is pinned', () => {
    // A pinned offering id fixes which offer Amazon sells, and decide() already held that offer's
    // price against the ceiling. Unpinned, nothing determines what will be charged.
    const pinned = { asin: 'B0TESTASIN', maxPrice: 100, quantity: 1, offerPinned: true };
    const loose = { asin: 'B0TESTASIN', maxPrice: 100, quantity: 1, offerPinned: false };
    assert.strictEqual(g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: null }, pinned).ok, true);
    const r = g.verifyCheckoutPage({ asin: 'B0TESTASIN', lineItemCount: 1, price: null }, loose);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /not pinned/);
  });
});

describe('challenge detection', () => {
  test('a captcha or sign-in redirect is a challenge', () => {
    assert.strictEqual(g.looksChallenged('https://www.amazon.ca/errors/validateCaptcha', ''), true);
    assert.strictEqual(g.looksChallenged('https://www.amazon.ca/ap/signin?x=1', ''), true);
  });

  test('a small challenge body is detected', () => {
    assert.strictEqual(g.looksChallenged('https://www.amazon.ca/dp/x', 'Enter the characters you see below'), true);
  });

  test('a big page mentioning robots is NOT a challenge', () => {
    // Amazon's own pages carry these strings; size is what separates them.
    assert.strictEqual(g.looksChallenged('https://www.amazon.ca/dp/x', 'x'.repeat(80000) + ' not a robot '), false);
  });

  test('Amazon\'s own out-of-stock landing is recognised', () => {
    assert.strictEqual(g.isOutOfStockUrl('https://www.amazon.ca/checkout/entry/oos?asin=x'), true);
    assert.strictEqual(g.isOutOfStockUrl('https://www.amazon.ca/checkout/p/123/spc'), false);
  });
});
