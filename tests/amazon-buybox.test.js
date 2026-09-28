/**
 * The Amazon browser bridge's buy-box parser.
 *
 * This file decides what a /dp/ page read in the client's Chrome MEANS, so every trap the paid
 * Amazon paths already paid for applies here too:
 *
 *   STOCK IS THE PINNED OFFER'S PRICE, not "a price appears somewhere". `_offersToData` defines
 *   it that way because B0C75FSW7C has four priced marketplace listings behind an unpriced
 *   pinned offer. On a /dp/ page the buy box IS the pinned offer, so the price must come from
 *   the buy-box blocks and nowhere else — a price scraped from the used/other-sellers module is
 *   exactly the unscoped kind that wrote $229.00 into B0H78BB9TY (real price $89.99) and later
 *   published a -61% price drop that never happened.
 *
 *   A TITLELESS READ IS INCONCLUSIVE, never out of stock. The verdict contract lets `no-stock`
 *   send and only `wrong-identity` suppress; "we never got a page" is neither, and turning it
 *   into an OOS write would silence restocks.
 *
 *   THE SELLER NAME IS THE WHOLE NAME. "Ships from and sold by Amazon.ca." cut at the first "."
 *   yields "Amazon" — a different merchant from Amazon.ca, and the wrong answer to hand the
 *   "sold by Amazon only" gate.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { parseBuyboxSlice, parsePrice, sellerFromPhrase } = require('../src/utils/amazon-buybox');

const TITLE = '<span id="productTitle">  Pokémon TCG: Prismatic Evolutions Elite Trainer Box </span>';
const price = (text, id = 'corePrice_feature_div') =>
  `<div id="${id}"><span class="a-price"><span class="a-offscreen">${text}</span></span></div>`;
const cart = () => '<div id="add-to-cart-button" data-tcg-present="1"></div>';
const avail = (text) => `<div id="availability"><span>${text}</span></div>`;
const merchant = (text) => `<div id="merchant-info">${text}</div>`;

describe('parsePrice', () => {
  test('reads every shape amazon.ca renders', () => {
    assert.strictEqual(parsePrice('$86.03'), 86.03);
    assert.strictEqual(parsePrice('CDN$ 86.03'), 86.03);
    assert.strictEqual(parsePrice('CDN$86.03'), 86.03);
    assert.strictEqual(parsePrice('$1,299.99'), 1299.99);
    assert.strictEqual(parsePrice('86,03 $'), 86.03, 'fr-CA decimal comma');
  });

  test('refuses anything that is not a single plain number', () => {
    // A range must never become a price: it is not an offer, and publishing the low end as THE
    // price is how a fake drop gets alerted.
    assert.strictEqual(parsePrice('from $40'), null);
    assert.strictEqual(parsePrice('$12.99 / count'), null);
    assert.strictEqual(parsePrice(''), null);
    assert.strictEqual(parsePrice(null), null);
    assert.strictEqual(parsePrice('$0.00'), null, 'zero is not a buyable price');
  });
});

describe('sellerFromPhrase', () => {
  test('keeps the dot inside a seller name', () => {
    // The regression this test exists for: cutting at the first "." reported "Amazon".
    assert.strictEqual(sellerFromPhrase('Ships from and sold by Amazon.ca.'), 'Amazon.ca');
    assert.strictEqual(sellerFromPhrase('Sold by Amazon.ca'), 'Amazon.ca');
  });

  test('drops the fulfilment clause, keeping the merchant', () => {
    assert.strictEqual(sellerFromPhrase('Sold by CoolCards and Fulfilled by Amazon.'), 'CoolCards');
  });

  test('no "sold by" phrase is null, not a guess', () => {
    assert.strictEqual(sellerFromPhrase('Ships from Amazon'), null);
    assert.strictEqual(sellerFromPhrase(''), null);
  });
});

describe('parseBuyboxSlice', () => {
  test('a priced buy box with no unavailability marker is IN STOCK and pinned', () => {
    // `cart()` is required for `pricePinned` now: measured on live pages, the price block can
    // render with no buy box at all, and an unscoped price flagged authoritative manufactures a
    // fake price drop.
    const d = parseBuyboxSlice(TITLE + price('CDN$ 86.03') + avail('In Stock') + cart()
      + merchant('Ships from and sold by Amazon.ca.'));
    assert.strictEqual(d.name, 'Pokémon TCG: Prismatic Evolutions Elite Trainer Box');
    assert.strictEqual(d.price, 86.03);
    assert.strictEqual(d.inStock, true);
    assert.strictEqual(d.pricePinned, true, 'the buy box IS the pinned offer on a /dp/ page');
    assert.strictEqual(d.seller, 'Amazon.ca');
  });

  test('"Only 2 left in stock" is still in stock', () => {
    const d = parseBuyboxSlice(TITLE + price('$86.03') + avail('Only 2 left in stock - order soon.'));
    assert.strictEqual(d.inStock, true);
  });

  test('a price alongside "Currently unavailable" is NOT in stock', () => {
    // Amazon keeps rendering a price block on some unavailable listings, so price alone would
    // call them in stock. The page's own words win.
    const d = parseBuyboxSlice(TITLE + price('$86.03') + avail('Currently unavailable.'));
    assert.strictEqual(d.inStock, false);
    assert.strictEqual(d.price, 86.03, 'the price is still reported — it just is not buyable');
  });

  test('#outOfStock vetoes a price too', () => {
    const d = parseBuyboxSlice(TITLE + price('$86.03') + '<div id="outOfStock">x</div>');
    assert.strictEqual(d.inStock, false);
  });

  test('no price at all is out of stock, and the price is null not zero', () => {
    const d = parseBuyboxSlice(TITLE + avail('Currently unavailable.'));
    assert.strictEqual(d.price, null, 'null so the caller can carry the cached price forward');
    assert.strictEqual(d.inStock, false);
    assert.strictEqual(d.pricePinned, false);
  });

  test('a price OUTSIDE the buy-box blocks is never read', () => {
    // The core of the price-provenance rule: an "other sellers" price is a different offer.
    const other = '<div id="mbc"><span class="a-offscreen">$229.00</span></div>';
    const d = parseBuyboxSlice(TITLE + other + avail('In Stock'));
    assert.strictEqual(d.price, null, 'a non-buybox price must not be adopted');
    assert.strictEqual(d.inStock, false);
  });

  test('a slice with no title is INCONCLUSIVE — null, never an OOS verdict', () => {
    assert.strictEqual(parseBuyboxSlice(price('$86.03') + avail('In Stock')), null);
    assert.strictEqual(parseBuyboxSlice('<span id="productTitle">   </span>'), null);
    assert.strictEqual(parseBuyboxSlice(''), null);
    assert.strictEqual(parseBuyboxSlice(null), null);
  });

  test('#apex_desktop is NOT a price source — measured empty on live pages', () => {
    // Measured on a live in-stock amazon.ca page 2026-09-28: #apex_desktop is 86,037 bytes and
    // its first .a-offscreen is EMPTY, while #corePrice_feature_div is 2,537 bytes and yields
    // "$21.31" correctly. It is no longer extracted at all (page.js SLICE), so a slice carrying
    // one must not produce a price.
    const d = parseBuyboxSlice(TITLE + price('$40.00', 'apex_desktop') + avail('In Stock') + cart());
    assert.strictEqual(d.price, null);
    assert.strictEqual(d.inStock, false, 'no readable buy-box price => not in stock');
  });

  test('the seller profile link wins over the merchant blurb', () => {
    const d = parseBuyboxSlice(TITLE + price('$10.00') + avail('In Stock')
      + '<a id="sellerProfileTriggerId">CoolCards</a>' + merchant('Ships from and sold by Amazon.ca.'));
    assert.strictEqual(d.seller, 'CoolCards');
  });

  test('an unknown seller is null, never invented', () => {
    const d = parseBuyboxSlice(TITLE + price('$10.00') + avail('In Stock'));
    assert.strictEqual(d.seller, null);
  });

  test('bare "out of stock" is NOT in stock — this was missing entirely', () => {
    const d = parseBuyboxSlice(TITLE + price('$86.03') + avail('Out of stock.') + cart());
    assert.strictEqual(d.inStock, false, 'a price beside "Out of stock" is not a restock');
  });

  test("French unavailability is recognised — the profile locale decides the wording", () => {
    // The bridge fetches with credentials, so the profile's language cookie picks the locale.
    // The first draft looked for "non disponible actuellement"; Amazon renders the words the
    // other way round, so a French profile would have reported the whole catalogue in stock.
    for (const phrase of ['Actuellement indisponible', 'Rupture de stock', 'Épuisé']) {
      const d = parseBuyboxSlice(TITLE + price('$86.03') + avail(phrase) + cart());
      assert.strictEqual(d.inStock, false, phrase);
    }
  });

  test('a missing add-to-cart button does not veto stock', () => {
    // The bridge FETCHES the page rather than rendering it, and that control is assembled
    // client-side — its absence is a property of how we read, not of the offer.
    const d = parseBuyboxSlice(TITLE + price('$86.03') + avail('In Stock'));
    assert.strictEqual(d.inStock, true);
    assert.strictEqual(d._canBuy, false);
  });
});

describe('#availability can be a SCRIPT block — measured on live OOS pages 2026-09-28', () => {
  // B0H77VZBX4 and B0G3CV6Z9D, fetched from a real amazon.ca session: with no buy box, Amazon
  // reuses id="availability" for a script, so .text() returned
  //   P.when("A", "load").execute("aod-assets-loaded", function(A){ function logAssets...
  // The literal string below is that shape. Neither page had #outOfStock either, so the ONLY
  // honest out-of-stock signal on them is the absent price.
  const AOD_SCRIPT = '<div id="availability"><script type="text/javascript">'
    + 'P.when("A", "load").execute("aod-assets-loaded", function(A){ function logAssets(){} });'
    + '</script></div>';

  test('a script-only availability is not mistaken for stock text', () => {
    const d = parseBuyboxSlice('<span id="productTitle">Pokemon TCG</span>' + AOD_SCRIPT);
    assert.strictEqual(d.inStock, false, 'no price block means out of stock');
    assert.strictEqual(d.price, null);
  });

  test('THE DANGEROUS CASE: a price block on an unavailable listing still gets vetoed', () => {
    // This is why the veto has to survive a script blob. Amazon does render a price on some
    // unavailable listings; if the availability text is JavaScript the veto silently never fires
    // and we alert on a product nobody can buy.
    const d = parseBuyboxSlice(
      '<span id="productTitle">Pokemon TCG</span>'
      + '<div id="corePrice_feature_div"><span class="a-offscreen">$27.99</span></div>'
      + '<div id="availability"><script>P.when("A").execute("aod-assets-loaded");</script>'
      + '<span>Currently unavailable.</span></div>'
    );
    assert.strictEqual(d.inStock, false, 'the real text must still be found past the script');
  });

  test('the script text itself can never satisfy the veto either way', () => {
    // Guard against "fixing" this by loosening UNAVAILABLE until JS happens to match it.
    const d = parseBuyboxSlice(
      '<span id="productTitle">Pokemon TCG</span>'
      + '<div id="corePrice_feature_div"><span class="a-offscreen">$34.99</span></div>'
      + AOD_SCRIPT
      + '<div id="add-to-cart-button" data-tcg-present="1"></div>'
    );
    assert.strictEqual(d.inStock, true, 'a priced, buyable listing is in stock');
    assert.strictEqual(d.pricePinned, true);
  });

  test('the real in-stock shape from B0BZJWNBRZ parses correctly', () => {
    // Measured the same run: $34.99, "Only 2 left in stock.", cart and buy-now both present.
    const d = parseBuyboxSlice(
      '<input type="hidden" id="ASIN" value="B0BZJWNBRZ">'
      + '<span id="productTitle">Pokemon Ampharos ex/Lucario ex Battle Deck</span>'
      + '<div id="corePrice_feature_div"><span class="a-offscreen">$34.99</span></div>'
      + '<div id="availability"><span>Only 2 left in stock.</span></div>'
      + '<div id="add-to-cart-button" data-tcg-present="1"></div>'
      + '<div id="buy-now-button" data-tcg-present="1"></div>'
    );
    assert.strictEqual(d.inStock, true);
    assert.strictEqual(d.price, 34.99);
    assert.strictEqual(d.pricePinned, true, 'cart present => the price is authoritative');
    assert.strictEqual(d.asin, 'B0BZJWNBRZ');
    assert.strictEqual(d.name, 'Pokemon Ampharos ex/Lucario ex Battle Deck');
  });

  test('"Only N left in stock" is never read as unavailable', () => {
    // It contains "in stock" but the UNAVAILABLE regex looks for "out of stock" — pinning that
    // these do not collide, since a low-stock restock is the exact case the client cares about.
    const d = parseBuyboxSlice(
      '<span id="productTitle">P</span>'
      + '<div id="corePrice_feature_div"><span class="a-offscreen">$9.99</span></div>'
      + '<div id="availability"><span>Only 2 left in stock.</span></div>'
    );
    assert.strictEqual(d.inStock, true);
  });
});
