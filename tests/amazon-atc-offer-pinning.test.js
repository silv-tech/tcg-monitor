/**
 * Amazon One Click Checkout links must be able to name the offer the alert fired on.
 *
 * THE BUG THIS PINS. The ATC links carried only `ASIN.1`, so Amazon added whatever sat in the buy
 * box at the moment somebody CLICKED — not the offer that triggered the alert. This adapter
 * spends real effort proving the pinned offer is sold by Amazon before it sends (see
 * amazon-seller.js and the seller gate in delivery.js), and then handed over a link that did not
 * name that offer. A scalper taking the buy box in the seconds between alert and click gets the
 * sale, and every layer of the seller gate is bypassed at the last step.
 *
 * WHY BOTH LINK SETS EXIST. They fail in opposite directions:
 *   - a stale OLID hard-errors on Amazon's side  -> bad for a human, correct for a bot
 *   - a bare ASIN silently falls back to the buy box -> fine for a human, wrong for a bot
 * So the pinned links are ADDED, never substituted. A test below pins that, because "tidying up
 * the duplicate links" is exactly the change that would silently reintroduce the bug.
 *
 * ENCODING IS LOAD-BEARING. An OLID is base64 and contains `+`, `/` and `=`. Pasted raw into a
 * query string the `+` decodes to a SPACE and Amazon resolves a different offer — the same trap
 * already documented on the `Offer Id` field.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildEmbed } = require('../src/discord/embeds');

// A real-shaped OLID: base64, and deliberately carrying the three characters that break a raw URL.
const OLID = 'kDTr%2Bnh8L9c+aBcD/efGH=';

function embedFor(over = {}, eventOver = {}) {
  const product = {
    sku: 'B0TESTASIN',
    name: 'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
    price: 86.03,
    currency: 'CAD',
    url: 'https://www.amazon.ca/dp/B0TESTASIN',
    retailer: 'Amazon Canada',
    retailerId: 'amazon',
    inStock: true,
    ...over,
  };
  return buildEmbed({ type: 'RESTOCK', product, ...eventOver });
}

const fieldsNamed = (embed, name) => (embed.data.fields || []).filter(f => f.name === name);
const allText = (embed) => (embed.data.fields || []).map(f => `${f.name}\n${f.value}`).join('\n');

describe('Amazon ATC offer pinning', () => {
  test('emits pinned-offer links carrying the OLID', () => {
    const embed = embedFor({ _offerId: OLID });
    const pinned = fieldsNamed(embed, 'One Click Checkout (this offer)');
    assert.strictEqual(pinned.length, 1, 'expected one pinned-offer field');
    assert.match(pinned[0].value, /OfferListingId\.1=/);
    assert.match(pinned[0].value, /Quantity\.1=1/);
    assert.match(pinned[0].value, /Quantity\.1=2/);
    assert.match(pinned[0].value, /Quantity\.1=3/);
  });

  test('the OLID is percent-encoded — a raw + would resolve a different offer', () => {
    const embed = embedFor({ _offerId: OLID });
    const value = fieldsNamed(embed, 'One Click Checkout (this offer)')[0].value;
    const encoded = encodeURIComponent(OLID);
    assert.ok(value.includes(`OfferListingId.1=${encoded}`), 'OLID must appear percent-encoded');
    // The decisive assertion: no bare +, /, or = from the token survives into the query string.
    const urls = value.match(/https:\/\/[^)]+/g) || [];
    for (const u of urls) {
      const q = u.split('?')[1] || '';
      const olidParam = q.split('&').find(p => p.startsWith('OfferListingId.1=')) || '';
      assert.ok(!/[+]/.test(olidParam), `raw + survived into ${olidParam}`);
      assert.ok(!olidParam.slice('OfferListingId.1='.length).includes('/'), 'raw / survived');
    }
  });

  test('the plain ASIN links are KEPT, not replaced', () => {
    // They are the human fallback: a stale OLID errors, a bare ASIN still adds something.
    const embed = embedFor({ _offerId: OLID });
    const plain = fieldsNamed(embed, 'One Click Checkout');
    assert.strictEqual(plain.length, 2, 'both original ATC fields must survive');
    assert.match(allText(embed), /ASIN\.1=B0TESTASIN/);
    assert.match(allText(embed), /ATCx12/, 'the x12 link is only on the plain set');
  });

  test('the alert-time OLID wins over the stored one', () => {
    // event._offerListingId is resolved at delivery, closest to the moment of truth.
    const embed = embedFor({ _offerId: 'STORED_OLID' }, { _offerListingId: 'LIVE_OLID' });
    const value = fieldsNamed(embed, 'One Click Checkout (this offer)')[0].value;
    assert.match(value, /OfferListingId\.1=LIVE_OLID/);
    assert.ok(!value.includes('STORED_OLID'), 'the stale stored OLID must not be used');
  });

  test('NO pinned field when there is no OLID — never invent one', () => {
    // A fabricated or empty OfferListingId would hard-error for every user who clicked it.
    const embed = embedFor({});
    assert.strictEqual(fieldsNamed(embed, 'One Click Checkout (this offer)').length, 0);
    assert.strictEqual(fieldsNamed(embed, 'One Click Checkout').length, 2, 'plain links still there');
    assert.ok(!allText(embed).includes('OfferListingId'));
  });

  test('non-Amazon retailers are untouched', () => {
    const embed = buildEmbed({
      type: 'RESTOCK',
      product: {
        sku: 'SHOP-1', name: 'Pokemon TCG Booster Box', price: 100, currency: 'CAD',
        url: 'https://example.myshopify.com/products/x', retailer: 'Some Shop',
        retailerId: 'someshop', inStock: true, _variantId: '12345', _offerId: OLID,
      },
    });
    assert.strictEqual(fieldsNamed(embed, 'One Click Checkout (this offer)').length, 0);
    assert.ok(!allText(embed).includes('OfferListingId'));
  });
});
