/**
 * The seller gate must never turn "we don't know" into "third party".
 *
 * THE INCIDENT THIS PINS — B0H77VZBX4, 2026-09-28 01:59 UTC. A real Amazon restock of a PRIORITY
 * watchlist ASIN at $27.99 was silently suppressed. Three causes stacked:
 *
 *   1. The priority lane fetched an offers payload that NAMED the pinned offer's seller, kept
 *      name/price/pinned_offer, and threw `seller_name` away.
 *   2. Delivery then re-fetched the same endpoint and that read produced nothing.
 *   3. The AOD fallback took `sellerMatches[0]` — the first seller anywhere among six offers —
 *      and returned "Eternal Emporium", a different offer entirely. Logged as `(live read)`,
 *      so it read like the gate working correctly.
 *
 * Measured the same day against the live endpoint: an Amazon-sold pinned offer returns
 * `seller_name: "Amazon.ca"`. So the answer was available for free at detection time, and the
 * re-read only existed because it had been discarded.
 *
 * The governing asymmetry: a wrong SEND is visible and correctable; a wrong SUPPRESSION is
 * invisible and permanent — poll-adapter writes the new stock state right after delivery, so the
 * restock can never re-fire. Unknown must therefore fail OPEN.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const AmazonAdapter = require('../src/adapters/amazon');

const adapter = () => new AmazonAdapter({
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
  intervalMs: 6000, proxyTier: 'none',
});

const payload = (over = {}) => ({
  item: { name: 'Pokémon TCG: 30th Celebration Tech Sticker Collection' },
  listings: [{ price: 27.99, pinned_offer: true, seller_name: 'Amazon.ca' }],
  ...over,
});

describe('_offersToData keeps the seller it paid for', () => {
  test('the pinned offer\'s seller survives', () => {
    const d = adapter()._offersToData(payload());
    assert.strictEqual(d.seller, 'Amazon.ca');
    assert.strictEqual(d.inStock, true);
    assert.strictEqual(d.price, 27.99);
  });

  test('a third-party pinned seller survives too — this is not an Amazon-only field', () => {
    const d = adapter()._offersToData(payload({
      listings: [{ price: 27.99, pinned_offer: true, seller_name: 'Eternal Emporium' }],
    }));
    assert.strictEqual(d.seller, 'Eternal Emporium');
  });

  test('ONLY the flagged pinned offer may supply it', () => {
    // listings[0] is "top offer" and may be any marketplace seller — the same trap already
    // documented for price provenance. Taking its seller would reintroduce the bug one layer up.
    const d = adapter()._offersToData(payload({
      listings: [{ price: 27.99, seller_name: 'Some Marketplace Co' }],
    }));
    assert.strictEqual(d.seller, null, 'an unflagged listing must not supply the seller');
    assert.strictEqual(d.price, 27.99, 'but it may still supply the price, as before');
  });

  test('an empty seller_name is null, never an empty string', () => {
    const d = adapter()._offersToData(payload({
      listings: [{ price: 27.99, pinned_offer: true, seller_name: '' }],
    }));
    assert.strictEqual(d.seller, null);
  });

  test('the existing contract is unchanged', () => {
    const d = adapter()._offersToData(payload());
    assert.strictEqual(d.name, 'Pokémon TCG: 30th Celebration Tech Sticker Collection');
    assert.strictEqual(d.pricePinned, true);
    assert.strictEqual(adapter()._offersToData(null), null);
    assert.strictEqual(adapter()._offersToData({ listings: [] }), null, 'no title => no read');
  });
});

describe('_applyOffersData carries the seller onto the row', () => {
  test('the detection-time seller and its timestamp are recorded', () => {
    const a = adapter();
    a._knownProducts.set('B0H77VZBX4', { sku: 'B0H77VZBX4', name: 'Pokémon TCG: 30th Celebration Tech Sticker Collection', inStock: false });
    const now = Date.now();
    a._applyOffersData('B0H77VZBX4', a._offersToData(payload()), {}, now, 'priority-offers');
    const p = a._knownProducts.get('B0H77VZBX4');
    assert.strictEqual(p._buyBoxSeller, 'Amazon.ca');
    assert.strictEqual(p._buyBoxSellerAt, now);
  });

  test('a read that learns no seller does not erase one we already had', () => {
    const a = adapter();
    a._knownProducts.set('B0H77VZBX4', {
      sku: 'B0H77VZBX4', name: 'Pokémon TCG: 30th Celebration Tech Sticker Collection',
      inStock: false, _buyBoxSeller: 'Amazon.ca', _buyBoxSellerAt: 1000,
    });
    a._applyOffersData('B0H77VZBX4', a._offersToData(payload({
      listings: [{ price: 27.99, pinned_offer: true, seller_name: '' }],
    })), {}, Date.now(), 'priority-offers');
    const p = a._knownProducts.get('B0H77VZBX4');
    assert.strictEqual(p._buyBoxSeller, 'Amazon.ca', 'absence is not evidence of a new seller');
    assert.strictEqual(p._buyBoxSellerAt, 1000, 'and the age must not be refreshed by a non-read');
  });
});

describe('the AOD fallback no longer launders unknown into third-party', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/utils/scraper-api.js'), 'utf8');

  test('the "first seller anywhere" fallback is GONE', () => {
    // It returned a seller belonging to a DIFFERENT offer. Because the regex needs an
    // `<a role="link">` that only marketplace sellers render, "Amazon holds the buy box" and
    // "no seller found" are the same input — so this fallback could only ever answer third party.
    assert.ok(!/sellerMatches\s*\[\s*0\s*\]/.test(src),
      'reading sellerMatches[0] must not come back — it names a different offer');
    assert.ok(!/if \(!seller\) \{[\s\S]{0,200}matchAll/.test(src),
      'no unpinned seller fallback may exist');
  });

  test('the PINNED seller read is still there', () => {
    // Removing the fallback must not remove the legitimate pinned read.
    assert.match(src, /pinnedSeller/, 'the pinned-block seller read must survive');
  });
});
