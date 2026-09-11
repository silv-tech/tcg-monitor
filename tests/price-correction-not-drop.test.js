/**
 * Correcting an untrustworthy price is not a price drop.
 *
 * THE INCIDENT, 2026-09-11. ASIN B0H78BB9TY, "Pokemon TCG: 30th Celebration Elite Trainer Box",
 * real price $89.99. Two alerts one minute apart:
 *
 *     21:32  RESTOCK      $229.00                     <- a price we had just decided not to trust
 *     21:32  PRICE DROP   $229.00 -> $89.99  (-61%)   <- a sale that never happened
 *
 * The restock itself was real and the $89.99 was right. Everything else was ours.
 *
 * HOW. Most Amazon price paths are not scoped to the buy box — the search tile shows whatever
 * offer Amazon features, and the AOD regex takes the first price in the fragment. One of them
 * wrote $229.00, and because an out-of-stock read carries the cached price forward, it survived
 * indefinitely. When the priority lane finally read the FLAGGED PINNED offer at $89.99, the
 * steep-drop guard compared the good number against the bad one and:
 *
 *   1. held the drop, rewriting next.price back to $229 — and that object IS event.product, so
 *      the restock embed published the very figure the guard was rejecting;
 *   2. was then "confirmed" 0.37s later by the next poll, because amazon.js re-emits its whole
 *      in-memory catalogue every 6s. The second observation was a replay of the same read. Real
 *      reads of that ASIN are ~238s apart, so the confirmation bought 2.5 seconds.
 *
 * THE FIX. Price provenance is explicit: only a read off the flagged pinned offer sets
 * _pricePinned. When an authoritative price replaces one that was never authoritative, that is a
 * CORRECTION — take it, log it, and suppress the price-change event, because there was never a
 * trustworthy high price to drop from. A genuine steep drop between two trustworthy prices is
 * still held for confirmation, and a held price is never published.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { EVENT_TYPES } = require('../src/core/events');
const { buildAlertEmbed } = require('../src/discord/embeds');

const STEEP_DROP_PCT = 50;

/** Mirrors the steep-drop block in poll-adapter.js. */
function steepDrop(prev, next) {
  if (prev.price > 0 && next.price > 0 && next.price < prev.price) {
    const dropPct = ((prev.price - next.price) / prev.price) * 100;
    if (dropPct >= STEEP_DROP_PCT) {
      if (next._pricePinned && !prev._pricePinned) {
        next._steepDropStreak = 0;
        next._priceCorrected = true;
      } else {
        const streak = (prev._steepDropStreak || 0) + 1;
        next._steepDropStreak = streak;
        if (streak < 2) {
          next.price = prev.price;
          next._priceHeld = true;
        }
      }
    } else {
      next._steepDropStreak = 0;
    }
  } else if (next.price === prev.price) {
    next._steepDropStreak = 0;
  }
  return next;
}

const row = (over = {}) => ({
  sku: 'B0H78BB9TY', name: 'Pokemon TCG: 30th Celebration Elite Trainer Box',
  retailer: 'Amazon Canada', retailerId: 'amazon', inStock: true, price: 89.99, ...over,
});

describe('the exact incident', () => {
  test('an authoritative price replacing an unverified one is a CORRECTION, not a drop', () => {
    const prev = row({ price: 229, inStock: false });          // written by an unscoped path
    const next = steepDrop(prev, row({ price: 89.99, _pricePinned: true }));

    assert.strictEqual(next.price, 89.99, 'the pinned read is the truth and must be kept');
    assert.strictEqual(next._priceCorrected, true, 'so the price-change event can be dropped');
    assert.strictEqual(next._priceHeld, undefined, 'nothing is being held, so nothing is hidden');
  });

  test('the restock that rides along shows the REAL price, not the rejected one', () => {
    const prev = row({ price: 229, inStock: false });
    const next = steepDrop(prev, row({ price: 89.99, _pricePinned: true }));

    const { embed } = buildAlertEmbed({ type: EVENT_TYPES.RESTOCK, product: next,
      oldValue: false, newValue: true });
    const price = embed.data.fields.find((f) => f.name === 'Price').value;
    assert.match(price, /89\.99/, 'the client saw $229.00 here — the number we had just rejected');
    assert.ok(!price.includes('229'), 'the stale price must not appear at all');
  });
});

describe('a genuine steep drop is still treated with suspicion', () => {
  test('two trustworthy prices: the first sighting is held', () => {
    const prev = row({ price: 200, _pricePinned: true });
    const next = steepDrop(prev, row({ price: 80, _pricePinned: true }));

    assert.strictEqual(next.price, 200, 'held at the old price so no event fires yet');
    assert.strictEqual(next._steepDropStreak, 1);
    assert.strictEqual(next._priceHeld, true);
  });

  test('a held price is never PUBLISHED — that is what leaked $229', () => {
    const prev = row({ price: 200, _pricePinned: true });
    const next = steepDrop(prev, row({ price: 80, _pricePinned: true }));

    const { embed } = buildAlertEmbed({ type: EVENT_TYPES.RESTOCK, product: next,
      oldValue: false, newValue: true });
    const price = embed.data.fields.find((f) => f.name === 'Price').value;
    assert.match(price, /TBD/, 'we are actively doubting this figure, so do not assert one');
    assert.ok(!price.includes('200'), 'and certainly not the number we declined to believe');
  });

  test('the second sighting lets it through', () => {
    const prev = row({ price: 200, _pricePinned: true, _steepDropStreak: 1 });
    const next = steepDrop(prev, row({ price: 80, _pricePinned: true }));

    assert.strictEqual(next.price, 80, 'confirmed, so believe it');
    assert.strictEqual(next._steepDropStreak, 2);
    assert.strictEqual(next._priceHeld, undefined);
  });
});

describe('the correction rule is narrow on purpose', () => {
  test('unverified -> unverified is still held, not waved through', () => {
    const next = steepDrop(row({ price: 229 }), row({ price: 89.99 }));
    assert.strictEqual(next._priceCorrected, undefined, 'neither side is authoritative');
    assert.strictEqual(next.price, 229, 'so the old suspicious behaviour still applies');
  });

  test('authoritative -> authoritative is a real drop, never a correction', () => {
    const next = steepDrop(row({ price: 200, _pricePinned: true }),
      row({ price: 80, _pricePinned: true }));
    assert.strictEqual(next._priceCorrected, undefined);
  });

  test('a shallow fall is untouched whatever the provenance', () => {
    const next = steepDrop(row({ price: 100 }), row({ price: 90, _pricePinned: true }));
    assert.strictEqual(next.price, 90, '10% is an ordinary price move');
    assert.strictEqual(next._priceCorrected, undefined);
    assert.strictEqual(next._steepDropStreak, 0);
  });

  test('a retailer with no provenance at all behaves exactly as before', () => {
    // Only Amazon stamps _pricePinned. Every other store must be unaffected.
    const next = steepDrop({ price: 200 }, { price: 80 });
    assert.strictEqual(next.price, 200);
    assert.strictEqual(next._steepDropStreak, 1);
    assert.strictEqual(next._priceCorrected, undefined);
  });
});

describe('provenance comes only from the flagged pinned offer', () => {
  const AmazonAdapter = require('../src/adapters/amazon');
  const a = new AmazonAdapter({ id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca', intervalMs: 6000 });

  test('a flagged pinned offer is authoritative', () => {
    const d = a._offersToData({ item: { name: 'X' }, listings: [{ pinned_offer: true, price: 89.99 }] });
    assert.deepStrictEqual({ price: d.price, pinned: d.pricePinned }, { price: 89.99, pinned: true });
  });

  test('the listings[0] fallback is NOT — it can be any marketplace seller', () => {
    const d = a._offersToData({ item: { name: 'X' }, listings: [{ price: 229 }, { price: 89.99 }] });
    assert.strictEqual(d.price, 229, 'still degrades to the top offer, as documented');
    assert.strictEqual(d.pricePinned, false, 'but it must never be treated as the buy-box price');
  });

  test('no price means no provenance', () => {
    const d = a._offersToData({ item: { name: 'X' }, listings: [{ pinned_offer: true }] });
    assert.strictEqual(d.price, null);
    assert.strictEqual(d.pricePinned, false);
  });
});
