/**
 * The Amazon browser bridge's server half: the work queue and the ingest path.
 *
 * Four properties here are load-bearing, and each fails silently if it is ever reversed.
 *
 *   THE BRIDGE IS A READER, NOT A DISCOVERY LANE. It may only write stock for an ASIN already
 *   tracked. A mis-targeted tab would otherwise write one product's buy box under another
 *   product's ASIN, straight into a paid alert channel, and the endpoint would double as a way
 *   to inject a product no scope rule has ever seen.
 *
 *   `_watchlist` IS NOT UNCONDITIONALLY TRUE. `_applyOffersData` hardcodes it because the
 *   priority lane only ever handles hand-picked ASINs. The bridge covers every in-scope ASIN, so
 *   copying that line would hand ~780 products the 45s dedup window, the rate-limiter exemption,
 *   the WATCHLIST header and the priority channel — see tcg-amazon-priority-watchlist.
 *
 *   AN INCONCLUSIVE READ CHANGES NOTHING. A slice with no title means we never got the page. It
 *   must not become an out-of-stock write, which would silence exactly the fastest-selling items.
 *
 *   THE BRIDGE HAS ITS OWN STALENESS CLOCK. Sharing `lastSeen` — which every lane writes — would
 *   let a search tile mark an ASIN fresh for the bridge, so its buy box would never be read.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');

function adapter(over = {}) {
  return new AmazonAdapter({
    id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
    intervalMs: 6000, proxyTier: 'none', ...over,
  });
}

const IN_SCOPE = 'Pokémon TCG: Prismatic Evolutions Elite Trainer Box';
const OUT_OF_SCOPE = 'Sticky Soccer Dart Board Game for Kids';

function known(a, asin, over = {}) {
  a._knownProducts.set(asin, { sku: asin, name: IN_SCOPE, price: 80, inStock: false, ...over });
}

const TITLE = (n) => `<span id="productTitle">${n}</span>`;
// The cart marker is part of a real in-stock slice, and `pricePinned` now requires it: the price
// block can render on a page with no buy box, and an unscoped price flagged authoritative
// manufactures a fake price drop.
const slice = (name, priceText, availText = 'In Stock') => TITLE(name)
  + (priceText ? `<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">${priceText}</span></span></div>` : '')
  + `<div id="availability"><span>${availText}</span></div>`
  + (priceText ? '<div id="add-to-cart-button" data-tcg-present="1"></div>' : '')
  + '<div id="merchant-info">Ships from and sold by Amazon.ca.</div>';

describe('getBridgeBatch', () => {
  test('returns tracked in-scope ASINs as /dp/ work items', () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA');
    known(a, 'B0BBBBBBBB');
    const items = a.getBridgeBatch(10);
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(
      items.map((i) => i.url).sort(),
      ['https://www.amazon.ca/dp/B0AAAAAAAA', 'https://www.amazon.ca/dp/B0BBBBBBBB']
    );
  });

  test('skips out-of-scope rows — the client\'s own browsing footprint is not spent on them', () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA');
    known(a, 'B0JUNKJUNK', { name: OUT_OF_SCOPE });
    assert.deepStrictEqual(a.getBridgeBatch(10).map((i) => i.asin), ['B0AAAAAAAA']);
  });

  test('a seeded row with no name yet is KEPT — reading it is how it gets one', () => {
    const a = adapter();
    known(a, 'B0SEEDED000', { name: undefined });
    assert.deepStrictEqual(a.getBridgeBatch(10).map((i) => i.asin), ['B0SEEDED000']);
  });

  test('stalest first, so no ASIN can starve', () => {
    const a = adapter();
    known(a, 'B0FRESH0000');
    known(a, 'B0STALE0000');
    a._bridgeCheckedAt.set('B0FRESH0000', Date.now());
    a._bridgeCheckedAt.set('B0STALE0000', Date.now() - 600000);
    assert.strictEqual(a.getBridgeBatch(10)[0].asin, 'B0STALE0000');
    // Never read at all sorts ahead of both — checkedAt defaults to 0.
    known(a, 'B0NEVER0000');
    assert.strictEqual(a.getBridgeBatch(10)[0].asin, 'B0NEVER0000');
  });

  test('the hand-picked priority set jumps the queue even when freshly read', () => {
    const a = adapter({ priorityAsins: ['B0PRIORITY0'] });
    known(a, 'B0PRIORITY0');
    known(a, 'B0ORDINARY0');
    a._bridgeCheckedAt.set('B0PRIORITY0', Date.now());        // freshest
    a._bridgeCheckedAt.set('B0ORDINARY0', 0);                 // stalest
    assert.strictEqual(a.getBridgeBatch(10)[0].asin, 'B0PRIORITY0');
  });

  test('the priority set takes AT MOST half a batch, so the catalogue cannot starve', () => {
    // Uncapped priority-first looks right and quietly starves the tail: 10 priority ASINs in a
    // batch of 12 leaves two slots, so ~770 products advance two at a time — a six-hour pass.
    const a = adapter({ priorityAsins: Array.from({ length: 10 }, (_, i) => `B0PRIO${i}00000`) });
    for (let i = 0; i < 10; i++) known(a, `B0PRIO${i}00000`);
    for (let i = 0; i < 50; i++) known(a, `B0REST${String(i).padStart(5, '0')}`);

    const batch = a.getBridgeBatch(12);
    const prio = batch.filter((it) => it.asin.startsWith('B0PRIO')).length;
    assert.strictEqual(batch.length, 12);
    assert.strictEqual(prio, 6, 'half of 12, not all 10');
    assert.strictEqual(batch.length - prio, 6, 'the other half goes to the catalogue');
  });

  test('a batch of 1 still reaches the priority set', () => {
    const a = adapter({ priorityAsins: ['B0PRIORITY0'] });
    known(a, 'B0PRIORITY0');
    known(a, 'B0ORDINARY0');
    assert.deepStrictEqual(a.getBridgeBatch(1).map((i) => i.asin), ['B0PRIORITY0']);
  });

  test('the batch is backfilled from either side rather than returned short', () => {
    // A short list on one side must not waste a cycle by under-filling the batch.
    const a = adapter({ priorityAsins: ['B0PRIORITY0'] });
    known(a, 'B0PRIORITY0');
    for (let i = 0; i < 20; i++) known(a, `B0REST${String(i).padStart(5, '0')}`);
    assert.strictEqual(a.getBridgeBatch(12).length, 12, 'one priority ASIN, batch still full');

    const b = adapter({ priorityAsins: Array.from({ length: 12 }, (_, i) => `B0PRIO${i}00000`) });
    for (let i = 0; i < 12; i++) known(b, `B0PRIO${i}00000`);
    known(b, 'B0ORDINARY0');
    const batch = b.getBridgeBatch(12);
    assert.strictEqual(batch.length, 12, 'one ordinary ASIN, batch still full');
    assert.strictEqual(new Set(batch.map((i) => i.asin)).size, 12, 'and no ASIN read twice');
  });

  test('a REDIRECTED page is rejected, not filed under the requested ASIN', async () => {
    // Amazon answers a dead /dp/ with a redirect to a different product, not a 404. The slice
    // that comes back is a perfectly valid in-stock buy box — belonging to something else.
    const a = adapter({});
    known(a, 'B0REQUEST1', { inStock: false });
    const r = await a.ingestBrowserReads([{
      asin: 'B0REQUEST1',
      slice: '<input type="hidden" id="ASIN" value="B0SOMETHIN">' + slice('Other product', '$41.99'),
    }]);
    assert.strictEqual(r.accepted, 0);
    assert.strictEqual(r.rejected, 1);
    assert.strictEqual(a._knownProducts.get('B0REQUEST1').inStock, false,
      'a redirect must never flip the requested ASIN in stock');
  });

  test('a MATCHING #ASIN is accepted', async () => {
    const a = adapter({});
    known(a, 'B0MATCHIN1', { inStock: false });
    const r = await a.ingestBrowserReads([{
      asin: 'B0MATCHIN1',
      slice: '<input type="hidden" id="ASIN" value="B0MATCHIN1">' + slice('Real product', '$41.99'),
    }]);
    assert.strictEqual(r.accepted, 1);
    assert.strictEqual(a._knownProducts.get('B0MATCHIN1').inStock, true);
  });

  test('a slice with NO #ASIN is still accepted — unverifiable is not wrong', async () => {
    // Fail open, as everywhere else in this system: absence of the field is absence of evidence,
    // and treating it as a mismatch would silence every page whose layout drops the input.
    const a = adapter({});
    known(a, 'B0NOASINTG', { inStock: false });
    const r = await a.ingestBrowserReads([{ asin: 'B0NOASINTG', slice: slice('P', '$9.99') }]);
    assert.strictEqual(r.accepted, 1);
  });

  test('an UNREADABLE ASIN does not block the queue forever', async () => {
    // getBridgeBatch orders by staleness. If only a successful parse advanced the clock, an ASIN
    // that can never be read stays the stalest row and is re-picked in every batch — three of
    // them halve the cadence for everything else.
    const a = adapter({});
    known(a, 'B0UNREADAB', { inStock: false });
    const r = await a.ingestBrowserReads([{ asin: 'B0UNREADAB', slice: '<div>nothing usable</div>' }]);
    assert.strictEqual(r.rejected, 1, 'still rejected — it must not write stock');
    assert.ok(a._bridgeCheckedAt.get('B0UNREADAB') > 0, 'but the attempt was recorded');
  });

  test('an UNTRACKED asin never grows the checked-at map', async () => {
    // Otherwise a bad or hostile push allocates unbounded server-side state.
    const a = adapter({});
    await a.ingestBrowserReads([{ asin: 'B0NOTTRACK', slice: slice('X', '$1.00') }]);
    assert.strictEqual(a._bridgeCheckedAt.has('B0NOTTRACK'), false);
  });

  test('MORE blind priority ASINs than half the batch — all still covered', () => {
    // The regression this pins. A leftover `Math.ceil(n / 2)` cap gave the priority set 6 of 12
    // slots, so a 7th blind priority ASIN fell to a SLOWER rotation than sighted ones — in the
    // one lane that exists specifically to cover blind ASINs. Caught live 2026-09-28 by reading
    // the production queue, not by a test, which is why this one exists.
    const blind = Array.from({ length: 9 }, (_, i) => `B0BLIND${String(i).padStart(4, '0')}`);
    const a = adapter({ priorityAsins: blind });
    blind.forEach(x => known(a, x, { _stockUnobserved: true }));
    for (let i = 0; i < 40; i++) known(a, `B0TAIL${String(i).padStart(5, '0')}`);

    const batch = a.getBridgeBatch(12).map(i => i.asin);
    for (const x of blind) {
      assert.ok(batch.includes(x), `${x} is blind and priority — it must be in every batch`);
    }
  });

  test('the tail is still not starved', () => {
    // Uncapping blind must not resurrect the problem the cap was written for.
    const blind = ['B0BLIND0001', 'B0BLIND0002'];
    const a = adapter({ priorityAsins: blind });
    blind.forEach(x => known(a, x, { _stockUnobserved: true }));
    for (let i = 0; i < 40; i++) known(a, `B0TAIL${String(i).padStart(5, '0')}`);
    const batch = a.getBridgeBatch(12).map(i => i.asin);
    assert.ok(batch.filter(x => x.startsWith('B0TAIL')).length >= 5,
      'the catalogue must still advance while only 2 ASINs are blind');
  });

  test('blind counts are reportable, and match what the batch uses', () => {
    const a = adapter({ priorityAsins: ['B0BLIND0001', 'B0SIGHTED1'] });
    known(a, 'B0BLIND0001', { _stockUnobserved: true });
    known(a, 'B0SIGHTED1', { inStock: true });
    known(a, 'B0TAILBLND', { _stockUnobserved: true });
    const c = a.getBridgeBlindCounts();
    assert.strictEqual(c.blindPriority, 1);
    assert.strictEqual(c.blindTotal, 2);
    assert.strictEqual(c.priorityTotal, 2);
  });

  test('BLIND ASINs come first — this is the whole point of the bridge', () => {
    // Measured in production 2026-09-28: of 24 priority ASINs, 16 are visible to the free
    // search-tile lane and already detected in ~6s. The other 8 are invisible — Amazon drops an
    // ASIN from /s when it has no offer — so they are covered ONLY by the paid round-robin at
    // ~432s. Every missed alert came from that set: the competitor alerted B0H77VZBX4 38 times in
    // a day, we caught 4. The bridge must read what the free lane CANNOT.
    const a = adapter({ priorityAsins: ['B0SEEN000001', 'B0BLIND00001'] });
    known(a, 'B0SEEN000001');                                  // tile reports stock fine
    known(a, 'B0BLIND00001', { _stockUnobserved: true });       // tile tells us nothing
    known(a, 'B0TAIL000001');
    // Freshest-first would put the blind one last; blindness must outrank staleness.
    a._bridgeCheckedAt.set('B0BLIND00001', Date.now());
    a._bridgeCheckedAt.set('B0SEEN000001', 0);
    assert.strictEqual(a.getBridgeBatch(10)[0].asin, 'B0BLIND00001');
  });

  test('a row MISSING from the catalogue counts as blind', () => {
    // 6 of the 24 priority ASINs had no state row at all — invisible to every free lane.
    const a = adapter({ priorityAsins: ['B0GHOST00001', 'B0SEEN000001'] });
    known(a, 'B0SEEN000001');
    a._knownProducts.set('B0GHOST00001', undefined);
    const batch = a.getBridgeBatch(10);
    assert.ok(batch.length >= 1);
    assert.strictEqual(batch[0].asin, 'B0GHOST00001', 'no row = the free lane cannot see it');
  });

  test('blindness does not override the priority/tail split', () => {
    // A blind TAIL row must not jump ahead of the priority set — the client pays for those.
    const a = adapter({ priorityAsins: ['B0PRIORITY0'] });
    known(a, 'B0PRIORITY0');
    known(a, 'B0TAILBLIND', { _stockUnobserved: true });
    assert.strictEqual(a.getBridgeBatch(10)[0].asin, 'B0PRIORITY0');
  });

  test('the batch size is clamped, so a bad n cannot request the whole catalogue', () => {
    const a = adapter();
    for (let i = 0; i < 80; i++) known(a, `B0PAD${String(i).padStart(5, '0')}`);
    assert.strictEqual(a.getBridgeBatch(9999).length, 60);
    assert.strictEqual(a.getBridgeBatch(0).length, 12, 'falsy n falls back to the default');
    assert.strictEqual(a.getBridgeBatch('abc').length, 12);
  });
});

describe('ingestBrowserReads', () => {
  test('a priced buy box flips a tracked ASIN in stock, with an authoritative price', async () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA', { inStock: false, price: 80 });
    const r = await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: slice(IN_SCOPE, 'CDN$ 86.03') }]);
    assert.deepStrictEqual(r, { accepted: 1, rejected: 0, changed: 1 });

    const p = a._knownProducts.get('B0AAAAAAAA');
    assert.strictEqual(p.inStock, true);
    assert.strictEqual(p.price, 86.03);
    assert.strictEqual(p._pricePinned, true, 'the buy box IS the pinned offer');
    assert.strictEqual(p._priceUnobserved, undefined);
    assert.strictEqual(p._stockUnobserved, undefined, 'this read observed stock');
    assert.strictEqual(p._buyboxSeller, 'Amazon.ca', 'the seller the paid lane charges for');
  });

  test('REJECTS an ASIN it does not already track', async () => {
    const a = adapter();
    const r = await a.ingestBrowserReads([{ asin: 'B0UNKNOWN00', slice: slice(IN_SCOPE, '$10.00') }]);
    assert.deepStrictEqual(r, { accepted: 0, rejected: 1, changed: 0 });
    assert.strictEqual(a._knownProducts.has('B0UNKNOWN00'), false, 'must not invent a product');
  });

  test('a titleless slice is INCONCLUSIVE and leaves the row untouched', async () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA', { inStock: true, price: 86.03 });
    const r = await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: '<div id="availability">x</div>' }]);
    assert.deepStrictEqual(r, { accepted: 0, rejected: 1, changed: 0 });
    const p = a._knownProducts.get('B0AAAAAAAA');
    assert.strictEqual(p.inStock, true, 'an unread page must NEVER write out-of-stock');
    assert.strictEqual(p.price, 86.03);
  });

  test('an unpriced buy box carries the cached price forward and marks it unobserved', async () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA', { inStock: true, price: 86.03, _pricePinned: true });
    await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: slice(IN_SCOPE, null, 'Currently unavailable.') }]);
    const p = a._knownProducts.get('B0AAAAAAAA');
    assert.strictEqual(p.inStock, false);
    assert.strictEqual(p.price, 86.03, 'a replay, not a wipe — delivery drops a null-priced event');
    assert.strictEqual(p._priceUnobserved, true, 'a replay is not an observation');
    assert.strictEqual(p._pricePinned, true, 'provenance follows the value it describes');
  });

  test('_watchlist reflects what the ASIN actually is, never an unconditional true', async () => {
    const a = adapter({ watchlist: ['B0WATCHED00'] });
    known(a, 'B0WATCHED00');
    known(a, 'B0ORDINARY0');
    await a.ingestBrowserReads([
      { asin: 'B0WATCHED00', slice: slice(IN_SCOPE, '$10.00') },
      { asin: 'B0ORDINARY0', slice: slice(IN_SCOPE, '$10.00') },
    ]);
    assert.strictEqual(a._knownProducts.get('B0WATCHED00')._watchlist, true);
    assert.strictEqual(a._knownProducts.get('B0ORDINARY0')._watchlist, false,
      'stamping every ASIN would hand ~780 products the priority channel and the 45s dedup window');
  });

  test('an out-of-scope live title is KEPT, not adopted and not denylisted', async () => {
    // Only the delivery-time identity gate may make that call, and it can only see a divergence
    // if the stored name stays put.
    const a = adapter();
    known(a, 'B0AAAAAAAA', { name: IN_SCOPE });
    await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: slice(OUT_OF_SCOPE, '$10.00') }]);
    const p = a._knownProducts.get('B0AAAAAAAA');
    assert.strictEqual(p.name, IN_SCOPE, 'stored name must survive so the gate can see the divergence');
    assert.strictEqual(a._knownProducts.has('B0AAAAAAAA'), true, 'not dropped');
  });

  test('the bridge clock advances only on the bridge, not on lastSeen alone', async () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA');
    assert.strictEqual(a._bridgeCheckedAt.get('B0AAAAAAAA'), undefined);
    await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: slice(IN_SCOPE, '$10.00') }]);
    assert.ok(a._bridgeCheckedAt.get('B0AAAAAAAA') > 0, 'read marks it fresh FOR THE BRIDGE');
  });

  test('malformed records are counted, never thrown on, and never partial-write', async () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA');
    const r = await a.ingestBrowserReads([
      { asin: '', slice: 'x' },
      { asin: 'B0AAAAAAAA' },
      { asin: 'B0AAAAAAAA', slice: slice(IN_SCOPE, '$10.00') },
      null,
    ]);
    assert.strictEqual(r.accepted, 1);
    assert.strictEqual(r.rejected, 3);
  });

  test('refuses an empty or oversized push rather than half-applying it', async () => {
    const a = adapter();
    await assert.rejects(() => a.ingestBrowserReads([]), /no records/);
    await assert.rejects(() => a.ingestBrowserReads('nope'), /no records/);
    const many = Array.from({ length: 201 }, () => ({ asin: 'B0AAAAAAAA', slice: 'x' }));
    await assert.rejects(() => a.ingestBrowserReads(many), /too many records/);
  });

  test('a stock flip is reported as changed; an identical re-read is not', async () => {
    const a = adapter();
    known(a, 'B0AAAAAAAA', { inStock: false, price: 0 });
    const first = await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: slice(IN_SCOPE, '$86.03') }]);
    assert.strictEqual(first.changed, 1);
    const second = await a.ingestBrowserReads([{ asin: 'B0AAAAAAAA', slice: slice(IN_SCOPE, '$86.03') }]);
    assert.strictEqual(second.changed, 0, 'a steady state is not an event');
    assert.strictEqual(second.accepted, 1);
  });
});
