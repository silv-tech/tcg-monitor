/**
 * EB Games sent bursts of restock alerts at the same instant, repeatedly.
 *
 * The alert limiter recorded the shape exactly: "ebgames exceeded its alert rate limit —
 * 21 alerts in 0s". Twenty-one events from ONE poll. Products flapping independently cannot
 * do that; the catalogue was flipping as a unit.
 *
 * Two candidate causes were tested against the live site before writing any code. The listing
 * page's in-stock parse was measured over 12 consecutive reads and was perfectly stable
 * (12 cards, 9 in stock, byte-identical every time), which ruled out a flickering render and
 * left the deep crawl.
 *
 * The deep crawl decided a product no longer existed if every page returned HTTP 200. A page
 * can return 200 and contain no product cards at all — Odoo pagination drifts, a re-render
 * can omit the grid — and that counted as an authoritative "these products are gone". They
 * were dropped from the known catalogue, poll-adapter's stale cleanup marked them out of
 * stock, and the next crawl brought them all back at once as a wall of restocks.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const MAX_DROP_SHARE = 0.2;

// Mirrors the trust decision in _deepCrawl.
function mayDrop({ failed = 0, empty = 0, knownBefore = 0, freshSkus = [] }) {
  const wouldDrop = knownBefore
    ? [...Array(knownBefore).keys()].map(String).filter((sku) => !freshSkus.includes(sku)).length / knownBefore
    : 0;
  return failed === 0 && empty === 0 && wouldDrop <= MAX_DROP_SHARE;
}
const allSkus = (n) => [...Array(n).keys()].map(String);

describe('eb games deep crawl: a page that loads but finds nothing is not proof of deletion', () => {
  test('an empty page blocks the crawl from dropping anything', () => {
    // Every page returned 200, but one parsed zero cards. This is the exact case that
    // produced the bursts.
    assert.strictEqual(mayDrop({ failed: 0, empty: 1, knownBefore: 250, freshSkus: allSkus(250) }), false);
  });

  test('a clean crawl with all pages yielding products may still drop', () => {
    // 250 known, 245 seen — a normal 2% delisting.
    assert.strictEqual(mayDrop({ failed: 0, empty: 0, knownBefore: 250, freshSkus: allSkus(245) }), true);
  });

  test('a failed page still blocks dropping, as before', () => {
    assert.strictEqual(mayDrop({ failed: 1, empty: 0, knownBefore: 250, freshSkus: allSkus(250) }), false);
  });
});

describe('eb games deep crawl: the share guard', () => {
  test('a crawl that would delete most of the catalogue is not trusted', () => {
    // Technically clean, but wants to remove 60% of 250 products in one pass.
    assert.strictEqual(mayDrop({ failed: 0, empty: 0, knownBefore: 250, freshSkus: allSkus(100) }), false);
  });

  test('a small, believable delisting is allowed through', () => {
    // 10 of 250 gone — 4%, the shape of a real delisting.
    assert.strictEqual(mayDrop({ failed: 0, empty: 0, knownBefore: 250, freshSkus: allSkus(240) }), true);
  });

  test('exactly at the threshold is still allowed', () => {
    assert.strictEqual(mayDrop({ failed: 0, empty: 0, knownBefore: 100, freshSkus: allSkus(80) }), true);
  });

  test('one product past the threshold is not', () => {
    assert.strictEqual(mayDrop({ failed: 0, empty: 0, knownBefore: 100, freshSkus: allSkus(79) }), false);
  });

  test('a first crawl with nothing known yet is unaffected', () => {
    assert.strictEqual(mayDrop({ failed: 0, empty: 0, knownBefore: 0, freshSkus: [] }), true);
  });
});

describe('eb games deep crawl: _ingest reports what it found', () => {
  const { CARD_RE } = { CARD_RE: /<form role="article"[^>]*\boe_product_cart\b[^>]*>[\s\S]*?<\/form>/g };

  test('a page with no product cards yields zero, which is what flags it empty', () => {
    const html = '<html><body><div class="grid">no products here</div></body></html>';
    assert.strictEqual([...html.matchAll(CARD_RE)].length, 0);
  });

  test('a page with cards yields a positive count', () => {
    const card = '<form role="article" class="oe_product_cart"><a href="/shop/123-thing-9">' +
      '<h2 aria-label="Pokemon TCG Booster Box"></h2><input name="product_id" value="9"></form>';
    assert.strictEqual([...(card + card).matchAll(CARD_RE)].length, 2);
  });
});
