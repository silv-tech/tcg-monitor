/**
 * A page that MENTIONS an anti-bot vendor is not a page that was blocked by one.
 *
 * Pokemon Center's challenge detector matched the bare strings 'distil_referrer' and
 * 'Incapsula'. The site loads those scripts on every page it serves, including perfectly good
 * ones, so a genuine product page carrying price and availability was classified as a block
 * and discarded. Bright Data was returning real pages the whole time and every one was thrown
 * away — 0 of 1,195 products had a price while the fetch layer reported success.
 *
 * The same trap caught me twice in one session by hand: a bare 'datadome' match made me
 * report Bright Data as 0/5 when it was 5/5, and this is the code version of that mistake.
 * The rule these tests encode: the page that SHIPS the defence and the page that IS the
 * defence both name it, so naming it proves nothing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const PokemonCenter = require('../src/adapters/pokemoncenter');
const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;
const adapter = new PokemonCenter(list.find((r) => r.id === 'pokemoncenter'));

// A real product page: long, has product JSON-LD, and also references the bot vendors.
const realPage = (extra = '') => `<html><head>
  <script src="/vice-come-Soldenyson.js"></script>
  <script>window.distil_referrer = document.referrer;</script>
  <script src="https://js.datadome.co/tags.js"></script>
  <script type="application/ld+json">
    {"@type":"Product","name":"Pokémon TCG: 30th Celebration Booster Bundle",
     "offers":{"@type":"Offer","price":36.99,"availability":"http://schema.org/OutOfStock"}}
  </script>${extra}</head><body>${'x'.repeat(8000)}</body></html>`;

describe('challenge detector: a real page that names the vendor is NOT a block', () => {
  test('distil_referrer on a genuine product page does not discard it', () => {
    const html = realPage();
    assert.strictEqual(adapter.isChallengePage(html), false);
  });

  test('the datadome script tag does not discard it either', () => {
    assert.ok(realPage().includes('datadome'), 'precondition: the page does name datadome');
    assert.strictEqual(adapter.isChallengePage(realPage()), false);
  });

  test('and the page still parses to real price and availability', () => {
    const parsed = adapter._parseProductHtml(realPage());
    assert.ok(parsed, 'a real page must parse');
    assert.strictEqual(parsed.price, 36.99);
    assert.strictEqual(parsed.inStock, false);
  });
});

describe('challenge detector: genuine interstitials are still caught', () => {
  const blocks = [
    ['Imperva interstitial', '<html><head><title>Pardon Our Interruption</title></head><body>' + 'x'.repeat(600) + '</body></html>'],
    ['Incapsula resource iframe', '<html><body><iframe src="/_Incapsula_Resource?CWUDNSAI=23"></iframe>' + 'x'.repeat(600) + '</body></html>'],
    ['DataDome captcha', '<html><body><script src="https://geo.captcha-delivery.com/captcha/"></script>' + 'x'.repeat(600) + '</body></html>'],
    ['access denied', '<html><body>Access Denied' + 'x'.repeat(600) + '</body></html>'],
    ['human verification', '<html><body>Please verify you are a human' + 'x'.repeat(600) + '</body></html>'],
  ];
  for (const [label, html] of blocks) {
    test('catches ' + label, () => assert.strictEqual(adapter.isChallengePage(html), true));
  }

  test('an empty or truncated response is still a challenge', () => {
    assert.strictEqual(adapter.isChallengePage(''), true);
    assert.strictEqual(adapter.isChallengePage(null), true);
    assert.strictEqual(adapter.isChallengePage('<html>tiny</html>'), true);
  });
});

describe('challenge detector: the discriminating rule', () => {
  test('naming a vendor and BEING its block page are distinguishable', () => {
    // Same vendor named in both. Only one is a block.
    const good = realPage();
    const bad = '<html><body><iframe src="/_Incapsula_Resource?x=1"></iframe>' + 'x'.repeat(600) + '</body></html>';
    assert.strictEqual(adapter.isChallengePage(good), false);
    assert.strictEqual(adapter.isChallengePage(bad), true);
  });

  test('parsing succeeds on the real page and fails on the block', () => {
    // This ordering is the real safety net: the adapter parses first, so even a detector
    // false positive can no longer discard a page that yields product data.
    assert.ok(adapter._parseProductHtml(realPage()));
    const bad = '<html><body>Pardon Our Interruption' + 'x'.repeat(600) + '</body></html>';
    assert.ok(!adapter._parseProductHtml(bad));
  });
});
