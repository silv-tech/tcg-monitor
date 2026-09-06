/**
 * Pokemon Center bulk in-stock sweep.
 *
 * Fixtures are the real captured category pages, trimmed to their ld+json blocks and the
 * availability facet. The behaviours worth pinning down are the ones that were measured
 * against the live site and contradicted the obvious assumption:
 *
 *   - ld+json `availability` on a CATEGORY page is a constant OutOfStock (101/101 products
 *     across three pages), so the parser must not read it. Membership of the
 *     `?availability=true` listing is the stock signal instead.
 *   - `priceCurrency` on those pages says USD even on /en-ca/, but the number is the CAD
 *     price — verified to the cent against the product page. The number is kept, the label
 *     discarded.
 *   - a partial sweep must never clear anything, the same rule the EB Games deep crawl needed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PokemonCenter = require('../src/adapters/pokemoncenter');
const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;
const cfg = list.find((r) => r.id === 'pokemoncenter');

const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const P1 = fixture('pc-category-instock-p1.html');
const P2 = fixture('pc-category-instock-p2.html');

const make = () => {
  const a = new PokemonCenter(cfg);
  a._saveAvailability = async () => {};
  return a;
};

describe('category listing parser', () => {
  test('pulls sku, name and price and skips the carousel cells', () => {
    const rows = make()._parseCategoryHtml(P1);
    assert.strictEqual(rows.length, 31, '6 bloomreach carousel cells carry no mpn and must drop out');
    assert.ok(rows.every((r) => r.sku), 'every row needs an id');
    assert.ok(rows.every((r) => !/bloomreach/i.test(r.name)));
  });

  test('takes the sku from mpn, because the sku field ships empty here', () => {
    const rows = make()._parseCategoryHtml(P1);
    const row = rows.find((r) => r.sku === '10-10320-101');
    assert.ok(row, 'the Mewtwo & Mew binder is on page 1 of the filtered listing');
    // $53.99 is what its own product page reports, to the cent.
    assert.strictEqual(row.price, 53.99);
  });

  test('never reports availability from the listing itself', () => {
    const rows = make()._parseCategoryHtml(P1);
    assert.ok(rows.every((r) => !('inStock' in r)),
      'category availability is a constant OutOfStock and must not reach the caller');
  });

  test('pages are distinct product sets', () => {
    const a = make();
    const s1 = new Set(a._parseCategoryHtml(P1).map((r) => r.sku));
    const s2 = a._parseCategoryHtml(P2).map((r) => r.sku);
    assert.strictEqual(s2.filter((s) => s1.has(s)).length, 0);
  });
});

describe('sweep marks stock and clears safely', () => {
  const stubFetch = (a, pages) => {
    const brightData = require('../src/utils/brightdata');
    a._origConfigured = brightData.isConfigured;
    brightData.isConfigured = () => true;
    let i = 0;
    brightData.unlock = async () => ({ html: pages[i++] ?? null, reason: null });
  };

  test('marks listed products in stock, with their price', async () => {
    const a = make();
    a.sitemapProducts = new Map([['10-10320-101', { url: 'u', name: 'Pokemon Tcg Thing' }]]);
    stubFetch(a, [P1, P2, '<html></html>']);
    await a._sweepCategories();
    const got = a.availabilityCache.get('10-10320-101');
    assert.strictEqual(got.inStock, true);
    assert.strictEqual(got.price, 53.99);
  });

  test('ignores listed products that are not in our catalogue', async () => {
    const a = make();
    a.sitemapProducts = new Map();
    stubFetch(a, [P1, P2, '<html></html>']);
    await a._sweepCategories();
    assert.strictEqual(a.availabilityCache.size, 0);
  });

  test('a PARTIAL sweep clears nothing', async () => {
    const a = make();
    a.sitemapProducts = new Map([['gone-sku', { url: 'u', name: 'n' }]]);
    a.availabilityCache.set('gone-sku', { inStock: true, price: 10, image: '' });
    a._categoryInStock = new Set(['gone-sku']);
    // First page fails outright: the sweep is short and must not be treated as authoritative.
    stubFetch(a, [null]);
    await a._sweepCategories();
    assert.strictEqual(a.availabilityCache.get('gone-sku').inStock, true,
      'a failed fetch must never read as "everything sold out"');
  });

  test('a short sweep against the facet count also clears nothing', async () => {
    const a = make();
    a.sitemapProducts = new Map([['gone-sku', { url: 'u', name: 'n' }]]);
    a.availabilityCache.set('gone-sku', { inStock: true, price: 10, image: '' });
    a._categoryInStock = new Set(['gone-sku']);
    // Only page 1 of a 137-product listing, then an empty page: 31 < 137, so incomplete.
    stubFetch(a, [P1, '<html></html>']);
    await a._sweepCategories();
    assert.strictEqual(a.availabilityCache.get('gone-sku').inStock, true);
  });

  test('a complete sweep clears a product that has left the listing', async () => {
    const a = make();
    a.sitemapProducts = new Map([['gone-sku', { url: 'u', name: 'n' }]]);
    a.availabilityCache.set('gone-sku', { inStock: true, price: 10, image: '' });
    a._categoryInStock = new Set(['gone-sku']);
    // Claim the facet total is satisfied by page 1 alone, so the sweep counts as complete.
    const p1 = P1.replace(/"count":\s*137/, '"count":31');
    stubFetch(a, [p1]);
    await a._sweepCategories();
    const got = a.availabilityCache.get('gone-sku');
    assert.strictEqual(got.inStock, false);
    assert.strictEqual(got.price, 10, 'clearing stock must not discard the known price');
  });

  test('only sweep-sourced products are ever cleared', async () => {
    const a = make();
    a.sitemapProducts = new Map([['other-sku', { url: 'u', name: 'n' }]]);
    // Marked in stock by a per-product check, never seen by a sweep.
    a.availabilityCache.set('other-sku', { inStock: true, price: 22, image: '' });
    a._categoryInStock = new Set();
    const p1 = P1.replace(/"count":\s*137/, '"count":31');
    stubFetch(a, [p1]);
    await a._sweepCategories();
    assert.strictEqual(a.availabilityCache.get('other-sku').inStock, true,
      'the sweep is not authoritative for products it has never listed');
  });
});
