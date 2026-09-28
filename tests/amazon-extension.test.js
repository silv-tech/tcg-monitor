/**
 * The Amazon bridge's page-side logic, loaded from the real source through a vm.
 *
 * Two decisions in that file are load-bearing:
 *
 *   1. WHAT COUNTS AS A BLOCK. Two traps, and the Pokemon Center bridge fell into both before
 *      this pattern settled. NOT vendor markers alone — Amazon's own scripts mention captcha
 *      endpoints on perfectly good pages. And NOT size alone — "anything small is a block"
 *      turned one short response into a 30-minute halt there. A block is HTTP 503/429, or a body
 *      both far too small to be a product page AND carrying the challenge form.
 *
 *   2. WHAT LEAVES THE BROWSER. The add-to-cart and buy-now controls are reduced to a presence
 *      marker because their real markup carries a per-session CSRF blob. Posting that to the
 *      monitor would ship a live token for the client's own Amazon session off their machine.
 *
 * `extractSlice` needs a DOM, which node has not got, so it runs against a small cheerio-backed
 * DOMParser stand-in. That tests the SELECTION logic — which elements, and what is stripped —
 * not Chrome's parser, which is not ours to test.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cheerio = require('cheerio');

/** Just enough DOMParser for extractSlice: querySelector -> { id, textContent, outerHTML }. */
class FakeDOMParser {
  parseFromString(html) {
    const $ = cheerio.load(html);
    return {
      querySelector(sel) {
        const el = $(sel).first();
        if (el.length === 0) return null;
        return {
          id: el.attr('id') || '',
          textContent: el.text(),
          outerHTML: $.html(el),
        };
      },
    };
  }
}

function loadPage() {
  const src = fs.readFileSync(path.join(__dirname, '../amazon-extension/page.js'), 'utf8');
  // page.js exports and returns as soon as it sees a `module`, so it never touches `location` or
  // `window` here — which is also the proof it cannot start a read loop under test.
  const sandbox = {
    setTimeout, URLSearchParams, console, DOMParser: FakeDOMParser, module: { exports: {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.module.exports;
}

const { extractSlice, looksBlocked, SLICE } = loadPage();

const pad = (n) => 'x'.repeat(n);
const productPage = (extra = '') => '<html><body>'
  + '<span id="productTitle">Pokemon TCG: Prismatic Evolutions Elite Trainer Box</span>'
  + '<div id="corePrice_feature_div"><span class="a-offscreen">$86.03</span></div>'
  + '<div id="availability"><span>In Stock</span></div>'
  + extra
  + `<!--${pad(400000)}-->`   // a real /dp/ page is 400KB+; the padding stands in for the rest
  + '</body></html>';

describe('looksBlocked', () => {
  test('Amazon\'s throttle answers are blocks', () => {
    assert.strictEqual(looksBlocked(productPage(), { status: 503 }), true);
    assert.strictEqual(looksBlocked(productPage(), { status: 429 }), true);
  });

  test('the captcha interstitial is a block — small AND carrying the challenge', () => {
    const captcha = '<html><body><form action="/errors/validateCaptcha">'
      + 'Enter the characters you see below</form></body></html>';
    assert.strictEqual(looksBlocked(captcha, { status: 200 }), true);
  });

  test('a full product page is NOT a block, even though it is a 200 with scripts', () => {
    assert.strictEqual(looksBlocked(productPage(), { status: 200 }), false);
  });

  test('size alone is not evidence: a big page mentioning captcha still passes', () => {
    // The lesson from the Pokemon Center bridge — vendor markers appear on good pages, so the
    // marker test only applies to bodies too small to be a page in the first place.
    assert.strictEqual(
      looksBlocked(productPage('<script src="https://images-amazon.com/captcha/x.js"></script>'), { status: 200 }),
      false
    );
  });

  test('a small body with no challenge markup is a MISS, not a block', () => {
    // A miss retries on the next cycle; a block stops the bridge for an hour. Calling a blip a
    // block is how a bridge halts itself over nothing.
    assert.strictEqual(looksBlocked('<html><body>brief</body></html>', { status: 200 }), false);
  });

  test('an empty body is treated as a block rather than an empty page', () => {
    assert.strictEqual(looksBlocked('', { status: 200 }), true);
    assert.strictEqual(looksBlocked(null, { status: 200 }), true);
  });
});

describe('extractSlice', () => {
  test('returns the buy-box elements and nothing else', () => {
    const out = extractSlice(productPage('<div id="unrelated">tracking pixels</div>'));
    assert.match(out, /productTitle/);
    assert.match(out, /corePrice_feature_div/);
    assert.match(out, /availability/);
    assert.doesNotMatch(out, /unrelated/, 'only the listed selectors may leave the browser');
    assert.doesNotMatch(out, /tracking pixels/);
  });

  test('is a few KB, not the whole page', () => {
    const page = productPage();
    const out = extractSlice(page);
    assert.ok(page.length > 400000, 'fixture must be page-sized for this to mean anything');
    assert.ok(out.length < 5000, `slice should be small, got ${out.length}`);
  });

  test('STRIPS the add-to-cart markup, keeping only its presence', () => {
    // The real control carries a per-session CSRF token for the client's own Amazon session.
    const withToken = productPage(
      '<span id="add-to-cart-button" data-csrf="SECRET-SESSION-TOKEN" value="Add to Cart"></span>'
    );
    const out = extractSlice(withToken);
    assert.match(out, /id="add-to-cart-button"/, 'presence is kept');
    assert.doesNotMatch(out, /SECRET-SESSION-TOKEN/, 'the token must never leave the browser');
    assert.doesNotMatch(out, /data-csrf/);
  });

  test('a page with no title yields null — INCONCLUSIVE, never out of stock', () => {
    const noTitle = '<html><body><div id="availability">In Stock</div>' + `<!--${pad(400000)}-->` + '</body></html>';
    assert.strictEqual(extractSlice(noTitle), null);
    assert.strictEqual(extractSlice('<html><body><span id="productTitle">   </span></body></html>'), null);
  });

  test('missing optional elements are skipped, not emitted empty', () => {
    const minimal = '<html><body><span id="productTitle">Pokemon TCG Booster Box</span></body></html>';
    const out = extractSlice(minimal);
    assert.match(out, /productTitle/);
    assert.doesNotMatch(out, /corePrice_feature_div/);
  });

  test('every selector in SLICE is an id — the extension reads no class-based catch-alls', () => {
    for (const sel of SLICE) {
      assert.match(sel, /^#[\w-]+$/, `${sel} should be a single id selector`);
    }
  });
});

describe('probe', () => {
  // The bridge runs on Canadian Chrome; whoever maintains the parser cannot load amazon.ca. When
  // Amazon renames a block, this is the only thing that says WHICH one — from the options log,
  // without shipping page content off the operator's machine.
  const { probe } = loadPage();
  const parse = (html) => new FakeDOMParser().parseFromString(html);
  // probe() builds its array inside the vm sandbox, so it has that realm's Array.prototype and
  // deepStrictEqual would reject it on identity alone. Compare contents.
  const probed = (html) => [...probe(parse(html))];

  test('names the selectors a page does have', () => {
    const found = probed('<div id="availability">x</div><div id="merchant-info">y</div>');
    assert.deepStrictEqual(found, ['availability', 'merchant-info']);
  });

  test('a renamed title block is visible as its absence', () => {
    const found = probed('<div id="corePrice_feature_div">$1</div><div id="availability">x</div>');
    assert.ok(!found.includes('productTitle'), 'the missing selector is the diagnosis');
    assert.ok(found.includes('corePrice_feature_div'), 'and the ones that still work are named');
  });

  test('a page with none of them says so rather than returning noise', () => {
    assert.deepStrictEqual(probed('<div id="something-else">x</div>'), []);
  });
});
