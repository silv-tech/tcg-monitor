/**
 * A search-tile price must never inherit "this came from the pinned offer".
 *
 * _buildFromSearch builds a row as `{ ...cached, price: item.price ?? cached.price ?? 0 }`. It
 * REPLACES the price with the search tile's figure — an unscoped one, per the documented rule that
 * the tile shows whatever offer Amazon features — while carrying `_pricePinned` forward from the
 * cached row untouched. So after any authoritative offers read, the next tile read produces a row
 * that claims pinned provenance for a price that never came from the pinned offer.
 *
 * WHY THAT MATTERS NOW. Two guards depend on that flag being honest:
 *
 *   1. The price-CORRECTION rule (unverified -> pinned is not a drop) can only recognise a
 *      correction if the unverified side is actually marked unverified.
 *   2. The steep-drop hold treats pinned -> pinned as a REAL drop worth publishing once
 *      confirmed, and only holds it for one further observation.
 *
 * And the free $0 priority fast-path now runs _buildFromSearch over every priority ASIN on EVERY
 * poll (~6s). Those are genuine reads, so they legitimately advance the read-counting guard — two
 * of them, seconds apart, satisfy the confirmation. A good pinned price followed by a bad tile
 * price therefore reads as an authoritative 61% drop, confirmed in ~6s, and publishes a PRICE DROP
 * on the 24 hand-given client ASINs, in the lane with a 45s dedup window and multi-channel
 * fan-out.
 *
 * This is the 2026-09-11 B0H78BB9TY incident re-entering through a new door, and neither the
 * provenance fix nor the read-counting fix stops it, because both are being told the truth about
 * freshness and a lie about provenance.
 *
 * The fix: when the tile supplies the price, the row is NOT pinned. Provenance follows the value.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const AmazonAdapter = require('../src/adapters/amazon');
const { confirmObservation } = require('../src/core/poll-adapter');
const { EVENT_TYPES } = require('../src/core/events');
const { diffProducts } = require('../src/core/events');

const ASIN = 'B0H78BB9TY';
const NAME = 'Pokemon TCG: 30th Celebration Elite Trainer Box';

const makeAdapter = () => new AmazonAdapter({
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000,
});

/** A search tile as _parseSearchHtml / the asinMode /s lane yields it. */
const tile = (price) => ({ asin: ASIN, name: NAME, price, inStock: true, image: '' });

describe('provenance follows the value, not the row', () => {
  test('a tile price is NOT pinned, even when the cached row was', () => {
    const a = makeAdapter();
    // A real authoritative read happened first — this is the normal state for a priority ASIN.
    a._knownProducts.set(ASIN, {
      sku: ASIN, name: NAME, price: 229, inStock: true, _pricePinned: true,
    });

    const built = a._buildFromSearch(tile(89.99), '');
    assert.ok(built, 'the tile must still produce a row');
    assert.strictEqual(built.price, 89.99, 'the tile price is taken');
    assert.strictEqual(built._pricePinned, false,
      'the tile is not the buy box — claiming pinned provenance here defeats both price guards');
  });

  test('a tile with NO price keeps the cached price AND its provenance', () => {
    // Nothing was replaced, so nothing about provenance changed. This must not be collateral.
    const a = makeAdapter();
    a._knownProducts.set(ASIN, {
      sku: ASIN, name: NAME, price: 89.99, inStock: true, _pricePinned: true,
    });

    const built = a._buildFromSearch({ ...tile(undefined), _priceUnknown: true }, '');
    assert.strictEqual(built.price, 89.99, 'the cached price survives');
    assert.strictEqual(built._pricePinned, true,
      'the price still came from the pinned offer, so the flag must stay true');
  });

  test('a first sighting from a tile is unpinned, not undefined', () => {
    const a = makeAdapter();
    const built = a._buildFromSearch(tile(89.99), '');
    assert.strictEqual(built._pricePinned, false);
  });
});

describe('the false PRICE DROP this prevents', () => {
  /** Two genuine free-path reads, ~6s apart, as the priority fast-path produces them. */
  const twoFreeReads = (a, prevRow, tilePrice) => {
    const first = a._buildFromSearch(tile(tilePrice), '');
    first.lastSeen = prevRow.lastSeen + 6000;
    const afterFirst = confirmObservation(first, prevRow, 'Amazon Canada', ASIN);

    const second = a._buildFromSearch(tile(tilePrice), '');
    second.lastSeen = prevRow.lastSeen + 12000;
    const afterSecond = confirmObservation(second, afterFirst, 'Amazon Canada', ASIN);

    return { afterFirst, afterSecond };
  };

  test('a good pinned price followed by a bad tile price does NOT publish a drop', () => {
    const a = makeAdapter();
    const prevRow = {
      sku: ASIN, name: NAME, retailerId: 'amazon', retailer: 'Amazon Canada',
      price: 229, inStock: true, _pricePinned: true, lastSeen: 1_757_600_000_000,
    };
    a._knownProducts.set(ASIN, { ...prevRow });

    const { afterFirst, afterSecond } = twoFreeReads(a, prevRow, 89.99);

    // Both reads are genuine (lastSeen advances), so the read-counting guard is satisfied by
    // design. What stops the false alert is that a steep drop may only be published off an
    // authoritative price when the price it drops FROM was authoritative too.
    assert.strictEqual(afterFirst.price, 229, 'the trustworthy price is kept');
    assert.strictEqual(afterFirst._pricePinned, true,
      'and stays marked pinned, because the flag describes the value in the row — letting it go '
      + 'false makes the NEXT poll an unverified->unverified compare, which does confirm');
    assert.strictEqual(afterFirst._priceHeld, undefined,
      'nothing is hidden: the kept number is the one we trust, so a restock should print it');

    // No number of further unscoped reads may move it.
    assert.strictEqual(afterSecond.price, 229, 'a second tile read must not confirm it either');
    assert.strictEqual(afterSecond._steepDropStreak, 0, 'the streak never advanced');

    for (const [a, b] of [[prevRow, afterFirst], [afterFirst, afterSecond]]) {
      const drops = diffProducts({ [ASIN]: a }, { [ASIN]: b })
        .filter((e) => e.type === EVENT_TYPES.PRICE_CHANGE);
      assert.deepStrictEqual(drops, [],
        'the client must not receive a PRICE DROP for a product that never went on sale');
    }
  });

  test('a real pinned read DOES move the price down afterwards', () => {
    // The hold must not be a dead end: the authoritative lane still gets its say.
    const a = makeAdapter();
    const prevRow = {
      sku: ASIN, name: NAME, retailerId: 'amazon', retailer: 'Amazon Canada',
      price: 229, inStock: true, _pricePinned: true, lastSeen: 1_757_600_000_000,
    };
    a._knownProducts.set(ASIN, { ...prevRow });

    const { afterSecond } = twoFreeReads(a, prevRow, 89.99);
    assert.strictEqual(afterSecond.price, 229, 'still held after two tile reads');

    // Now the paid offers lane reads the pinned offer at the lower price, twice.
    const pinnedRead = (at) => ({
      sku: ASIN, name: NAME, retailerId: 'amazon', retailer: 'Amazon Canada',
      price: 89.99, inStock: true, _pricePinned: true, lastSeen: at,
    });
    const p1 = confirmObservation(pinnedRead(prevRow.lastSeen + 432_000), afterSecond, 'Amazon Canada', ASIN);
    assert.strictEqual(p1.price, 229, 'first authoritative sighting is held for confirmation');

    const p2 = confirmObservation(pinnedRead(prevRow.lastSeen + 864_000), p1, 'Amazon Canada', ASIN);
    assert.strictEqual(p2.price, 89.99, 'two authoritative reads agree — now it is believable');
  });

  test('a genuine pinned-to-pinned steep drop is still reported', () => {
    // The guard must not be so wide that it swallows real sales.
    const prev = {
      sku: ASIN, name: NAME, price: 200, inStock: true, _pricePinned: true,
      lastSeen: 1_757_600_000_000,
    };
    const read = (price, at) => ({
      sku: ASIN, name: NAME, retailerId: 'amazon', retailer: 'Amazon Canada',
      price, inStock: true, _pricePinned: true, lastSeen: at,
    });

    const first = confirmObservation(read(80, prev.lastSeen + 240_000), prev, 'Amazon Canada', ASIN);
    assert.strictEqual(first.price, 200, 'held on the first authoritative sighting');

    const second = confirmObservation(read(80, prev.lastSeen + 480_000), first, 'Amazon Canada', ASIN);
    assert.strictEqual(second.price, 80, 'confirmed by a second authoritative read');
    assert.strictEqual(second._priceCorrected, undefined, 'this IS a real drop');
  });
});
