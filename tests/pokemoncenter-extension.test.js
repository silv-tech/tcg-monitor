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
 *   2. What counts as a block. Two traps here, and the first version fell into both.
 *      NOT the presence of "datadome" or "captcha-delivery": those scripts load on perfectly
 *      good pages — verified on the working category page — and the adapter carries a note about
 *      that exact mistake discarding every real page.
 *      And NOT size alone either: "under 5000 bytes = blocked" halted the bridge for 30 minutes
 *      over one 1053-byte response. The user saw no challenge, the next cycles fetched normally,
 *      and re-fetching those URLs returned 200/459KB. A real challenge does not heal itself.
 *      A block is HTTP 429, or a body both too small to be a page AND carrying challenge markup.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadContent() {
  const src = fs.readFileSync(path.join(__dirname, '../pokemoncenter-extension/page.js'), 'utf8');
  // page.js exports and returns as soon as it sees a `module`, so it never touches `location`
  // or `window` here — which is also the proof it cannot start a read loop under test.
  const sandbox = { setTimeout, URLSearchParams, module: { exports: {} }, console };
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
  // The first version answered "under 5000 bytes = blocked" and halted for 30 minutes on a
  // single 1053-byte response. Measured 2026-09-11: the user saw no challenge, the next cycles
  // fetched normally, and re-fetching the same URLs returned 200/459KB every time. A real
  // challenge does not heal itself — so size alone is not evidence, and a lone short body must
  // cost one product, not half an hour of reads.
  const CHALLENGE = '<html><head><script src="https://geo.captcha-delivery.com/captcha/"></script>'
    + '</head><body>Please enable JS</body></html>';

  test('a genuine challenge page is caught', () => {
    assert.strictEqual(looksBlocked(CHALLENGE, { status: 200 }), true);
  });

  test('HTTP 429 is a block whatever the body says', () => {
    assert.strictEqual(looksBlocked('x'.repeat(50000), { status: 429 }), true);
  });

  test('a SHORT body that is not a challenge is NOT a block', () => {
    assert.strictEqual(looksBlocked('x'.repeat(1053), { status: 200 }), false,
      '1053 bytes with no challenge markup halted the bridge for 30 minutes for nothing');
  });

  test('a real product page is never a block, DataDome scripts and all', () => {
    const html = page([REAL_PRODUCT])
      + '<script src="https://js.captcha-delivery.com/x.js"></script>datadome';
    assert.strictEqual(looksBlocked(html, { status: 200 }), false,
      'these scripts load on GOOD pages — keying on them discards every real page');
  });

  test('an empty body is a block', () => {
    assert.strictEqual(looksBlocked('', { status: 200 }), true);
    assert.strictEqual(looksBlocked(null, { status: 200 }), true);
  });
});

describe('the reader lives in the PAGE world, and stays inert under test', () => {
  test('page.js loads with no window and no location, so it cannot have started a loop', () => {
    // The sandbox provides neither. Reaching this line means the file exported and returned
    // before touching either — which is also what keeps it inert outside the bridge tab.
    assert.ok(typeof extractProductLd === 'function');
    assert.ok(typeof looksBlocked === 'function');
  });

  test('the manifest runs page.js in the MAIN world and content.js in the isolated one', () => {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../pokemoncenter-extension/manifest.json'), 'utf8'));
    const byFile = Object.fromEntries(m.content_scripts.map((c) => [c.js[0], c]));
    // Pinning the deployed shape, NOT a claim that MAIN is required for reading. It is not:
    // per Chromium's url_request.mojom an isolated-world same-origin fetch carries the page as
    // its initiator, and the 0-of-20 failure was the parser, not the world.
    assert.strictEqual(byFile['page.js'].world, 'MAIN',
      'page.js is registered in the MAIN world; content.js relays because chrome.runtime is absent there');
    assert.strictEqual(byFile['content.js'].world, undefined,
      'the relay needs chrome.runtime, which does not exist in the MAIN world');
  });
});

describe('the wall this site actually raises is IMPERVA, not DataDome', () => {
  // Captured verbatim from the live site 2026-09-11. Under sustained reading pokemoncenter.com
  // answers HTTP 200 with ~1050 bytes — measured 1048-1058b across dozens — no Retry-After, no
  // x-datadome header, no redirect. It looks like a successful fetch to everything except a
  // human reading the body. One good 435KB page, then eleven consecutive blocks.
  //
  // The first detector looked only for DataDome and Cloudflare wording, so it called these
  // "short body" and the bridge kept hammering a server refusing every request.
  const IMPERVA = '<html><head><meta name="robots" content="noindex"><script>'
    + '(function(){window.sessionStorage.setItem("distil_referrer",document.referrer);})();'
    + '</script><script src="/vice-come-Soldenyson-it-non-Banquoh-Chare-Hart-C" async></script>'
    + '</head><body><h2>Request unsuccessful. Incapsula incident ID: 1097000730123456789-123</h2>'
    + '<iframe src="/_Incapsula_Resource?CWUDNSAI=9"></iframe></body></html>';

  test('the Imperva block page is recognised as a block', () => {
    // The live pages measured 1048-1058 bytes; this fixture is a trimmed copy of the same
    // markup. What matters is that it is far below a product page and carries the wall's words.
    assert.ok(IMPERVA.length < 5000, 'well under the size of any real product page');
    assert.strictEqual(looksBlocked(IMPERVA, { status: 200 }), true,
      'HTTP 200 with an Incapsula incident body is a wall, not a page');
  });

  test('its distinguishing words each trip the check on their own', () => {
    for (const marker of ['Incapsula', 'Request unsuccessful', 'distil', '_Incapsula_Resource']) {
      assert.strictEqual(looksBlocked(`<html><body>${marker}</body></html>`, { status: 200 }), true, marker);
    }
  });

  test('nothing is extracted from it, so it can never be mistaken for stock', () => {
    assert.strictEqual(extractProductLd(IMPERVA), null);
  });

  test('a real page mentioning none of it is still fine', () => {
    assert.strictEqual(looksBlocked(page([REAL_PRODUCT]), { status: 200 }), false);
  });
});
