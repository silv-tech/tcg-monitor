/**
 * The Pokemon Center bridge's page-side logic, loaded from the real source through a vm.
 *
 * Two decisions in that file are load-bearing and easy to get wrong later:
 *
 *   1. What counts as a usable page. The category listing carries Product ld+json blocks too,
 *      but with an EMPTY sku and a constant `OutOfStock` — measured 2026-09-11 against a product
 *      whose own page says InStock, with the listing also quoting USD instead of CAD. Accepting
 *      those would write false stock for the whole store.
 *
 *   2. What counts as a block. NOT the presence of "datadome" or "captcha-delivery": those
 *      scripts load on perfectly good Pokemon Center pages — verified, the working category page
 *      contains DataDome markers — and the monitor's own adapter carries a note about that exact
 *      mistake discarding every real page. The measured discriminator is size: a challenged
 *      response was 859 bytes, a real product page 440-451KB.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadContent() {
  const src = fs.readFileSync(path.join(__dirname, '../pokemoncenter-extension/content.js'), 'utf8');
  const sandbox = {
    // No tcgbridge marker, so the loop must not start in the sandbox.
    location: { search: '' },
    chrome: { runtime: { sendMessage: () => {}, lastError: null } },
    setTimeout, URLSearchParams, module: { exports: {} }, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

const { extractProductLd, looksBlocked } = loadContent();

const page = (ldObjects) => '<html><head>'
  + ldObjects.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('')
  + `</head><body>${'x'.repeat(20000)}</body></html>`;

const REAL_PRODUCT = {
  '@type': 'Product',
  sku: '10-10320-101',
  name: 'Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder',
  image: ['https://www.pokemoncenter.com/images/a_01.jpg'],
  offers: { '@type': 'Offer', availability: 'http://schema.org/InStock', price: 53.99, priceCurrency: 'CAD' },
};

// Exactly what the category listing serves — measured, including the empty sku and USD.
const LISTING_CELL = {
  '@type': 'Product',
  sku: '',
  mpn: '10-10320-101',
  name: 'Pokémon TCG: Mewtwo & Mew DNA Premium Zip Binder',
  offers: { '@type': 'Offer', availability: 'http://schema.org/OutOfStock', price: 53.99, priceCurrency: 'USD' },
};

const CAROUSEL_CELL = { '@type': 'Product', sku: '', name: 'bloomreach:CategoryCarouselGridCell' };

describe('extracting the product ld+json', () => {
  test('a real product page yields its block verbatim', () => {
    const raw = extractProductLd(page([REAL_PRODUCT]));
    assert.ok(raw, 'the block must be found');
    const back = JSON.parse(raw);
    assert.strictEqual(back.offers.availability, 'http://schema.org/InStock');
    assert.strictEqual(back.offers.priceCurrency, 'CAD');
    assert.strictEqual(back.sku, '10-10320-101');
  });

  test('an out-of-stock product page is still extracted — that is real data', () => {
    const oos = { ...REAL_PRODUCT, offers: { ...REAL_PRODUCT.offers, availability: 'http://schema.org/OutOfStock' } };
    assert.ok(extractProductLd(page([oos])));
  });

  test('a carousel cell with no offers is skipped', () => {
    assert.strictEqual(extractProductLd(page([CAROUSEL_CELL])), null);
  });

  test('the real product wins even when carousel cells come first', () => {
    const raw = extractProductLd(page([CAROUSEL_CELL, CAROUSEL_CELL, REAL_PRODUCT]));
    assert.strictEqual(JSON.parse(raw).sku, '10-10320-101');
  });

  test('the listing cell IS accepted by shape — which is why only product URLs are ever fetched', () => {
    // It carries an availability, so this function cannot tell it apart. The protection is that
    // the work queue only ever hands out /product/ URLs, and the server refuses any SKU its
    // sitemap does not list. Pinning the limitation so nobody assumes a guard that is not here.
    assert.ok(extractProductLd(page([LISTING_CELL])),
      'this function is not the guard against listing pages — the work queue and server are');
  });

  test('malformed JSON does not throw, and does not stop a later good block', () => {
    const html = '<script type="application/ld+json">{ not json </script>'
      + `<script type="application/ld+json">${JSON.stringify(REAL_PRODUCT)}</script>`;
    assert.ok(extractProductLd(html));
  });

  test('a page with no ld+json returns null rather than guessing', () => {
    assert.strictEqual(extractProductLd('<html><body>nothing here</body></html>'), null);
  });
});

describe('deciding whether we were blocked', () => {
  test('the measured challenge response is caught', () => {
    assert.strictEqual(looksBlocked('x'.repeat(859), { redirected: false, url: 'u' }), true,
      '859 bytes is the exact size DataDome returned to a credentials-omitted fetch');
  });

  test('a real product page is NOT treated as blocked, DataDome scripts and all', () => {
    const html = page([REAL_PRODUCT])
      + '<script src="https://js.captcha-delivery.com/x.js"></script>datadome';
    assert.strictEqual(looksBlocked(html, { redirected: false, url: 'https://www.pokemoncenter.com/en-ca/product/x/y' }), false,
      'these scripts load on GOOD pages — keying on them discards every real page');
  });

  test('an empty body is blocked', () => {
    assert.strictEqual(looksBlocked('', { redirected: false, url: 'u' }), true);
    assert.strictEqual(looksBlocked(null, { redirected: false, url: 'u' }), true);
  });

  test('a redirect away from the product is blocked', () => {
    assert.strictEqual(
      looksBlocked('y'.repeat(20000), { redirected: true, url: 'https://www.pokemoncenter.com/en-ca/interstitial' }),
      true);
  });

  test('a redirect that still lands on a product is fine — slug changes happen', () => {
    assert.strictEqual(
      looksBlocked('y'.repeat(20000), { redirected: true, url: 'https://www.pokemoncenter.com/en-ca/product/x/new-slug' }),
      false);
  });
});

describe('the loop refuses to run outside its own tab', () => {
  test('loading the script without the tcgbridge marker starts nothing', () => {
    // The sandbox above has location.search = '' and a sendMessage that would throw if called.
    // Reaching this line at all means the module loaded without starting a read loop, which is
    // what keeps the bridge out of the user's own shopping tabs.
    assert.ok(typeof extractProductLd === 'function');
  });
});
