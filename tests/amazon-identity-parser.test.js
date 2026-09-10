/**
 * Search-tile identity: a tile's name/price/image must come from the SAME tile as its ASIN.
 *
 * THE BUG THIS FIXES (verified live 2026-09-10): ASIN B0DRDRVZZT (a Jamieson Magnesium supplement,
 * $13.47, sold by Amazon.ca) was stored and alerted as "Pokémon TCG: Gardevoir ex League Battle
 * Deck" $81.87. Cause: _parseSearchHtml splits the page on data-component-type="s-search-result",
 * but not every tile carries that marker, so one "card" slice can hold several tiles. The parser
 * pulled ASIN, name and price as independent first-match regexes over the whole slice — so a thin
 * marker-less tile that had a csa-id but no <h2> of its own let the name/price regexes reach FORWARD
 * into the next tile, stapling a neighbour's Gardevoir title + $81.87 onto the magnesium ASIN.
 *
 * The fix confines name/alt/price/oos/image to the sub-slice between this tile's csa-id and the next
 * tile's csa-id. These tests reproduce the offset and prove it can't recur, plus the offers-lane
 * now DENYLISTS an out-of-scope live title (was evict-only, which let a stale tile re-admit it).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const state = require('../src/core/state');
state.denyIdentity = async () => {}; // stub Redis-backed persistence for the offers-lane test

const AmazonAdapter = require('../src/adapters/amazon');
function adapter() {
  const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon', url: 'https://www.amazon.ca', intervalMs: 6000, proxyTier: 'none', watchlist: [] });
  a.reportFreshness = () => {};
  return a;
}

const h2 = (n) => `<h2 class="a-size-base-plus" aria-label="${n}">${n}</h2>`;
const csa = (asin) => `data-csa-c-item-id="amzn1.asin.${asin}"`;
const priceBlock = (p) => `<div data-cy="price-recipe"><span class="a-price"><span class="a-offscreen">$${p}</span></span></div>`;
const img = (alt) => `<img class="s-image" src="https://m.media-amazon.com/images/I/x.jpg" alt="${alt}">`;

describe('the exact B0DRDRVZZT offset cannot recur', () => {
  test('a thin marker-less tile (csa-id, NO h2) followed by a Gardevoir tile does NOT get the Gardevoir name', () => {
    // One marker; two csa-ids in the slice. The FIRST tile (magnesium) has no h2 of its own.
    const html = `<div data-component-type="s-search-result" ${csa('B0DRDRVZZT')}>
        ${img('Jamieson Magnesium')}
        <div ${csa('B0GARDEVR1')}>
          ${h2('Pokémon TCG: Gardevoir ex League Battle Deck')}
          ${priceBlock('81.87')}
        </div>
      </div>`;
    const out = adapter()._parseSearchHtml(html);
    const bad = out.find((t) => t.asin === 'B0DRDRVZZT');
    assert.ok(!(bad && /gardevoir/i.test(bad.name)), 'magnesium ASIN must NEVER carry the Gardevoir name');
    // With no h2 of its own, the magnesium tile is simply dropped (correct — it's a foreign tile).
    assert.strictEqual(out.some((t) => t.asin === 'B0DRDRVZZT'), false, 'thin foreign tile dropped, not mis-bound');
  });

  test('a magnesium tile with its OWN h2 keeps its own name + no leaked neighbour price', () => {
    const html = `<div data-component-type="s-search-result" ${csa('B0DRDRVZZT')}>
        ${h2('Jamieson 100% Pure Magnesium Bisglycinate 100 mg Capsules 70 Count')}
        <div ${csa('B0GARDEVR1')}>
          ${h2('Pokémon TCG: Gardevoir ex League Battle Deck')}
          ${priceBlock('81.87')}
        </div>
      </div>`;
    const out = adapter()._parseSearchHtml(html);
    const mag = out.find((t) => t.asin === 'B0DRDRVZZT');
    assert.ok(mag, 'the tile with its own h2 is parsed');
    assert.match(mag.name, /Magnesium/i, 'bound to its OWN name');
    assert.doesNotMatch(mag.name, /gardevoir/i, 'never the neighbour name');
    assert.strictEqual(mag.price, null, 'the neighbour Gardevoir $81.87 must NOT leak onto the magnesium ASIN');
  });
});

describe('well-formed pages still parse correctly (no regression)', () => {
  test('two proper tiles, each with its own marker → each bound to its own name+price', () => {
    const one = (asin, name, price) => `<div data-component-type="s-search-result" ${csa(asin)}>${h2(name)}${priceBlock(price)}</div>`;
    const html = one('B0AAAAAAAA', 'Pokémon TCG: Prismatic Evolutions Elite Trainer Box', '69.99')
               + one('B0BBBBBBBB', 'One Piece Card Game Romance Dawn Booster Box', '119.99');
    const out = adapter()._parseSearchHtml(html);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out.find((t) => t.asin === 'B0AAAAAAAA').price, 69.99);
    assert.match(out.find((t) => t.asin === 'B0AAAAAAAA').name, /Prismatic/);
    assert.strictEqual(out.find((t) => t.asin === 'B0BBBBBBBB').price, 119.99);
    assert.match(out.find((t) => t.asin === 'B0BBBBBBBB').name, /One Piece/);
  });

  test('the real repo fixture (3 tiles, 2 markers) binds every ASIN to its own name', () => {
    const html = fs.readFileSync(__dirname + '/fixtures/amazon-search-tiles.html', 'utf8');
    const out = adapter()._parseSearchHtml(html);
    for (const t of out) {
      // every emitted tile must be a real TCG title, never a cross-bound foreign name
      assert.doesNotMatch(t.name, /cool maker|kpop|magnesium/i, `${t.asin} must not borrow a foreign tile's name (got "${t.name}")`);
    }
    // the two Mega-Evolution tiles keep their own identities
    const a = out.find((t) => t.asin === 'B0GYTRYV7P');
    const b = out.find((t) => t.asin === 'B0GYTWKXTR');
    assert.match(a.name, /Mega Evolution/);
    assert.match(b.name, /Mega Evolution/);
  });
});

describe('offers-lane out-of-scope drop now DENYLISTS (closes the re-admit hole)', () => {
  test('a live title out of scope adds the ASIN to _denied and evicts it', async () => {
    const a = adapter();
    const OLD = Date.now() - 60 * 60 * 1000;
    a._knownProducts.set('B0DRDRVZZT', { sku: 'B0DRDRVZZT', name: 'Pokémon TCG: Gardevoir ex League Battle Deck', price: 81.87, inStock: false, category: 'pokemon', lastSeen: OLD });
    a._fetchOffers = async () => ({ item: { name: 'Jamieson 100% Pure Magnesium Bisglycinate 100 mg' }, listings: [{ price: 13.47, pinned_offer: true }] });
    const products = {};
    await a._runOffersLane(products);
    assert.strictEqual(a._denied.has('B0DRDRVZZT'), true, 'confirmed out-of-scope live title is denylisted, not just evicted');
    assert.strictEqual(a._knownProducts.has('B0DRDRVZZT'), false, 'evicted from the catalogue');
    assert.strictEqual('B0DRDRVZZT' in products, false, 'not published this poll');
  });
});
