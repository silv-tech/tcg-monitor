/**
 * The Pokemon Center browser bridge.
 *
 * pokemoncenter.com sits behind DataDome, which refuses every HTTP client and every proxy —
 * residential raw 403, residential+Patchright 403, Patchright direct hits an Imperva
 * interstitial, ScraperAPI 500s at every tier. The paid unlocker that did work manages ~1,459
 * checks/day, which over the measured 8,415-SKU catalogue is 21 DAYS for a single pass. No
 * budget makes "track every product" work through it.
 *
 * A real browser is a different matter. Measured 2026-09-11 in the user's own Chrome:
 *   - a same-origin fetch of a product page returns the full server HTML, no challenge
 *   - its ld+json carries real `sku`, `offers.availability`, `price`, `priceCurrency: CAD`
 *   - `credentials: 'include'` is REQUIRED — with 'omit' the same fetch returns an
 *     859-byte DataDome challenge instead of 451KB of page
 *   - four in parallel finished in 3.6s, i.e. ~1.1 products/sec => ~2.1h for all 8,415
 *
 * So the bridge reads pages in the browser and posts back only the ld+json block: the page is
 * ~440KB and the block ~1.3KB, which turns a full pass from ~3.7GB into ~11MB. Parsing stays
 * server-side on the same parser the paid path used, so there is no second extraction to drift.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const PokemonCenterAdapter = require('../src/adapters/pokemoncenter');

const ld = (over = {}) => JSON.stringify({
  '@type': 'Product',
  sku: over.sku || '290-85982',
  name: over.name || 'Pokemon TCG: Prismatic Evolutions Elite Trainer Box',
  image: over.image || ['https://www.pokemoncenter.com/images/a_01.jpg', 'https://www.pokemoncenter.com/images/a_02.jpg'],
  offers: {
    '@type': 'Offer',
    availability: `http://schema.org/${over.availability || 'InStock'}`,
    price: over.price === undefined ? 59.99 : over.price,
    priceCurrency: 'CAD',
  },
});

function adapter(skus = ['A1', 'A2', 'A3']) {
  const a = new PokemonCenterAdapter({
    id: 'pokemoncenter', name: 'Pokemon Center',
    url: 'https://www.pokemoncenter.com', intervalMs: 8000,
  });
  a._saveAvailability = async () => {};
  a.sitemapProducts = new Map(skus.map((s) => [s, {
    url: `https://www.pokemoncenter.com/en-ca/product/${s}/slug-${s}`, name: `Product ${s}`,
  }]));
  return a;
}

let a;
beforeEach(() => { a = adapter(); });

describe('the work queue hands out the stalest products first', () => {
  test('a never-checked product outranks a checked one', () => {
    a.availabilityCache.set('A1', { inStock: false, price: 1, checkedAt: Date.now() });
    const batch = a.getWorkBatch(10);
    assert.strictEqual(batch.length, 3);
    assert.strictEqual(batch[batch.length - 1].sku, 'A1', 'the freshly checked one goes last');
  });

  test('among checked products the stalest comes first', () => {
    const now = Date.now();
    a.availabilityCache.set('A1', { checkedAt: now - 1000 });
    a.availabilityCache.set('A2', { checkedAt: now - 90000 });
    a.availabilityCache.set('A3', { checkedAt: now - 50000 });
    assert.deepStrictEqual(a.getWorkBatch(3).map((x) => x.sku), ['A2', 'A3', 'A1']);
  });

  test('it carries the en-ca URL the browser should fetch', () => {
    const [first] = a.getWorkBatch(1);
    assert.match(first.url, /^https:\/\/www\.pokemoncenter\.com\/en-ca\/product\//);
  });

  test('the batch size is clamped rather than trusted', () => {
    assert.strictEqual(a.getWorkBatch(99999).length, 3, 'cannot ask for more than exists');
    assert.strictEqual(a.getWorkBatch(0).length, 3, 'a junk size falls back to the default');
    assert.strictEqual(a.getWorkBatch('2').length, 2, 'a numeric string is honoured');
  });

  test('a PARKED product is still offered — parking is a paid-transport artifact', () => {
    // UNFETCHABLE parking counts unlocker failures, and expect_element parks on a selector the
    // unlocker never saw. Neither describes a browser, and 322 SKUs are parked right now purely
    // because the paid account is suspended. Skipping them would hide a third of the store.
    a._unfetchable.set('A2', { until: Date.now() + 3600000, reason: 'expect_element' });
    assert.ok(a.getWorkBatch(10).some((x) => x.sku === 'A2'));
  });
});

describe('a pushed read becomes stock', () => {
  test('it parses the ld+json block and stores stock, price and a STRING image', async () => {
    const r = await a.ingestPushed([{ sku: 'A1', ld: ld({ availability: 'InStock', price: 59.99 }) }]);
    assert.deepStrictEqual({ accepted: r.accepted, rejected: r.rejected }, { accepted: 1, rejected: 0 });

    const got = a.availabilityCache.get('A1');
    assert.strictEqual(got.inStock, true);
    assert.strictEqual(got.price, 59.99);
    assert.strictEqual(typeof got.image, 'string',
      'an array here reaches setThumbnail and throws away the alert permanently');
    assert.ok(got.checkedAt > 0, 'checkedAt is the rotation clock — without it the queue never advances');
    assert.strictEqual(got.source, 'bridge');
  });

  test('out of stock is recorded as out of stock, not skipped', async () => {
    await a.ingestPushed([{ sku: 'A1', ld: ld({ availability: 'OutOfStock' }) }]);
    assert.strictEqual(a.availabilityCache.get('A1').inStock, false);
  });

  test('it reports how many products actually CHANGED', async () => {
    await a.ingestPushed([{ sku: 'A1', ld: ld({ availability: 'OutOfStock' }) }]);
    const same = await a.ingestPushed([{ sku: 'A1', ld: ld({ availability: 'OutOfStock' }) }]);
    assert.strictEqual(same.changed, 0, 'an unchanged re-read is not a change');
    const moved = await a.ingestPushed([{ sku: 'A1', ld: ld({ availability: 'InStock' }) }]);
    assert.strictEqual(moved.changed, 1);
  });

  test('a successful read un-parks the product', async () => {
    a._unfetchable.set('A1', { until: Date.now() + 3600000, reason: 'expect_element' });
    a._failStreak.set('A1', 2);
    await a.ingestPushed([{ sku: 'A1', ld: ld() }]);
    assert.strictEqual(a._unfetchable.has('A1'), false, 'the browser could read it, so it is not unfetchable');
  });

  test('a whole batch is accepted in one call', async () => {
    const r = await a.ingestPushed([
      { sku: 'A1', ld: ld({ availability: 'InStock' }) },
      { sku: 'A2', ld: ld({ availability: 'OutOfStock' }) },
      { sku: 'A3', ld: ld({ availability: 'InStock' }) },
    ]);
    assert.strictEqual(r.accepted, 3);
    assert.strictEqual(a.availabilityCache.get('A2').inStock, false);
  });
});

describe('a push cannot write stock for the wrong product', () => {
  test('a SKU the sitemap does not list is refused', async () => {
    const r = await a.ingestPushed([{ sku: 'NOT-OURS', ld: ld() }]);
    assert.strictEqual(r.accepted, 0);
    assert.strictEqual(r.rejected, 1);
    assert.strictEqual(a.availabilityCache.has('NOT-OURS'), false,
      'a mis-targeted tab must not invent a product');
  });

  test('junk records are rejected individually, not fatally', async () => {
    const r = await a.ingestPushed([
      { sku: 'A1', ld: ld() },
      { sku: '', ld: ld() },
      { sku: 'A2' },
      { sku: 'A3', ld: 'not json at all' },
      null,
    ]);
    assert.strictEqual(r.accepted, 1, 'the good record still lands');
    assert.strictEqual(r.rejected, 4);
  });

  test('an empty or oversized batch is refused outright', async () => {
    await assert.rejects(() => a.ingestPushed([]), /no records/);
    await assert.rejects(() => a.ingestPushed('nope'), /no records/);
    const huge = Array.from({ length: 501 }, () => ({ sku: 'A1', ld: ld() }));
    await assert.rejects(() => a.ingestPushed(huge), /too many records/);
  });
});

describe('pushes feed the health signal', () => {
  test('successful reads count as fresh, unparseable ones do not', async () => {
    await a.ingestPushed([
      { sku: 'A1', ld: ld() },
      { sku: 'A2', ld: 'garbage' },
    ]);
    assert.strictEqual(a._freshAttempts, 2);
    assert.strictEqual(a._freshSuccesses, 1,
      'health must be able to see that half the reads produced nothing');
  });
});

describe('track-everything admits the whole store, and only for this store', () => {
  const SITEMAP = `<?xml version="1.0"?><urlset>
    <url><loc>https://www.pokemoncenter.com/product/290-85982/pokemon-tcg-prismatic-evolutions-elite-trainer-box</loc></url>
    <url><loc>https://www.pokemoncenter.com/product/70-11607/poke-ball-classic-clog-by-crocs-kids</loc></url>
    <url><loc>https://www.pokemoncenter.com/product/70-10984/gengar-purple-long-sleeve-sleep-shirt-adult</loc></url>
    <url><loc>https://www.pokemoncenter.com/product/71-10728/pokemon-polaroid-go-instant-camera-pikachu-edition</loc></url>
  </urlset>`;

  const build = (trackAll) => new PokemonCenterAdapter({
    id: 'pokemoncenter', name: 'Pokemon Center', url: 'https://www.pokemoncenter.com',
    intervalMs: 8000, trackAllProducts: trackAll,
  });

  test('WITHOUT the flag, only the TCG product survives — the old behaviour', () => {
    const a = build(false);
    a._parseSitemap(SITEMAP);
    assert.deepStrictEqual([...a.sitemapProducts.keys()], ['290-85982'],
      'crocs, shirts and cameras are filtered out, which is what reduced 8,415 to 805');
  });

  test('WITH the flag, the clog, the shirt and the camera are all tracked', () => {
    const a = build(true);
    a._parseSitemap(SITEMAP);
    assert.deepStrictEqual([...a.sitemapProducts.keys()].sort(),
      ['290-85982', '70-10984', '70-11607', '71-10728'].sort());
  });

  test('a non-TCG product is not silently dropped by the alert filters', () => {
    const a = build(true);
    const p = a.classify({ name: 'Poke Ball Classic Clog By Crocs Kids', sku: '70-11607' });
    // delivery.js drops any event whose product has isTCG === false, and routes no 'other'
    // category. Both would have discarded every non-TCG alert at a logger.debug.
    assert.strictEqual(p.isTCG, true);
    assert.strictEqual(p.category, 'pokemon', 'everything Pokemon Center sells is Pokemon');
  });

  test('a normal retailer is completely unaffected', () => {
    const a = build(false);
    const p = a.classify({ name: 'Poke Ball Classic Clog By Crocs Kids', sku: '70-11607' });
    assert.strictEqual(p.isTCG, false, 'the shared rule still applies everywhere else');
  });

  test('the scope purge can never run against a track-everything store', () => {
    const a = build(true);
    let called = false;
    a._purgeOutOfScopeState = async () => { called = true; return {}; };
    a._maybePurgeOutOfScope();
    assert.strictEqual(called, false,
      'at 7,610 of 8,415 out of "scope" the purge share is 0.904 against a 0.9 abort — it would '
      + 'have deleted the store by four thousandths of a margin');
  });
});
