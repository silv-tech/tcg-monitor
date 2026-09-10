/**
 * The identity gate must not be able to kill a product just because our own filter dislikes it.
 *
 * The gate suppresses AND permanently denylists on `wrong-identity`, and it decides that by asking
 * `isInScopeName` about the live title. That function is shared with ingestion, and it has a
 * CONFIRMED false-positive class: the marker /\bpromotion(?:al)? cards?\b/i matches the singular
 * "Promotion Card", which sealed products use to describe their own contents. Three real ASINs were
 * hit (B0GSCJ3V5C, B0GSC9654K, B0GTRFRHW3). Left unguarded, a restock of one of those would be
 * silenced and the ASIN denylisted — costing every future restock of a genuine product, which is a
 * strictly worse outcome than the drift this gate exists to prevent.
 *
 * The fix separates the two questions the gate was conflating:
 *
 *   "is this out of scope?"        our filter's opinion — can be wrong, and is
 *   "did the product CHANGE?"      what the gate actually exists to detect
 *
 * Only the second may suppress. If the live title still contains the stored name, nothing drifted,
 * whatever the scope rule thinks — so that returns `scope-mismatch`, which sends and logs.
 *
 * This cannot blind the gate, structurally: the scope check only ever fires on out-of-scope drift,
 * i.e. a jump to a different product CATEGORY, and a dart board cannot be titled like a Pokemon
 * card lot. Measured on every real case we have, the two populations do not overlap at all —
 * drifts score 0.00, same-product pairs score 1.00, against a 0.6 threshold.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { verifyAmazonListing, nameOverlap, SAME_PRODUCT_OVERLAP } = require('../src/utils/amazon-verify');

const serve = (title, price = 49.99) => async () => ({
  item: { name: title },
  listings: [{ pinned_offer: true, price, seller_name: 'Amazon.ca' }],
});

// Every drift that actually reached a customer, with the name we had stored for it.
const REAL_DRIFTS = [
  ['Pokemon TCG: Random Cards from Every Series, 100 Cards in Each Lot Plus 7 Bonus Free Foil Cards',
   'Sticky Soccer Dart Board Game for Kids Includes 3 Sticky Balls- Indoor/Outdoor Party Game for 5-12 Year Old Boys & Girls'],
  ['Pokemon TCG Gardevoir ex League Battle Deck', 'Nex Playground Kids Game Console'],
  ['Pokemon TCG Scarlet & Violet Booster Bundle', 'PopSockets PopGrip - Expanding Stand and Grip'],
  ['Pokemon TCG Gardevoir ex League Battle Deck', 'Jamieson Magnesium 500mg, 100 Caplets'],
];

// Real sealed products the scope rule wrongly rejects, with the name we had stored.
const SCOPE_FALSE_POSITIVES = [
  ["Pokemon TCG: Mega Evolution: Ascended Heroes: Pack of 2 Blister Packs (2 Booster Packs, Promotion Card and Coin) (Larry's Komala)",
   "Pokemon TCG: Mega Evolution: Ascended Heroes: Pack of 2 Blister Packs (2 Booster Packs, Promotion Card and Coin) (Larry's Komala)"],
  ['Pokemon TCG Mega Evolution Ascended Heroes 2-pack blister',
   "Pokemon TCG: Mega Evolution: Ascended Heroes: 2-pack blister (2 supplementary packages, promotional card and coins) (Erika's Tangela)"],
  ['Mega Zygarde-ex Premium Collection',
   'Mega Zygarde-ex Premium Collection by GCC Pokemon (one promotional card, one giant lenticular card, one sticker and eight expansion packs)'],
];

describe('every real drift is still caught', () => {
  for (const [stored, live] of REAL_DRIFTS) {
    test(`${live.slice(0, 34)}… is suppressed`, async () => {
      const v = await verifyAmazonListing('B0X', { fetcher: serve(live), storedName: stored });
      assert.strictEqual(v.verdict, 'wrong-identity',
        'the guard must not blunt the gate — this one reached a customer');
    });
  }

  test('all four score far below the threshold, so the margin is real', () => {
    for (const [stored, live] of REAL_DRIFTS) {
      const o = nameOverlap(stored, live);
      assert.ok(o < SAME_PRODUCT_OVERLAP / 2,
        `${o} is uncomfortably close to ${SAME_PRODUCT_OVERLAP} for "${live.slice(0, 30)}"`);
    }
  });
});

describe('a scope false positive is NOT treated as drift', () => {
  for (const [stored, live] of SCOPE_FALSE_POSITIVES) {
    test(`${live.slice(0, 34)}… is not suppressed`, async () => {
      const v = await verifyAmazonListing('B0X', { fetcher: serve(live), storedName: stored });
      assert.strictEqual(v.verdict, 'scope-mismatch');
      assert.notStrictEqual(v.verdict, 'wrong-identity',
        'suppressing here denylists a real product and costs every future restock of it');
    });
  }

  test('the two populations do not overlap, so the threshold is not finely tuned', () => {
    const worstDrift = Math.max(...REAL_DRIFTS.map(([s, l]) => nameOverlap(s, l)));
    const weakestSame = Math.min(...SCOPE_FALSE_POSITIVES.map(([s, l]) => nameOverlap(s, l)));
    assert.ok(weakestSame - worstDrift > 0.5,
      `separation collapsed: drift max ${worstDrift}, same-product min ${weakestSame}`);
    assert.ok(SAME_PRODUCT_OVERLAP > worstDrift && SAME_PRODUCT_OVERLAP < weakestSame,
      'the threshold must sit inside the empty gap between the populations');
  });
});

describe('the guard is inert unless it can help', () => {
  test('with no stored name the old behaviour stands — suppression, not silence', async () => {
    const v = await verifyAmazonListing('B0X', { fetcher: serve('Nex Playground Kids Game Console') });
    assert.strictEqual(v.verdict, 'wrong-identity',
      'a caller that passes no stored name must not silently lose the protection');
  });

  test('an in-scope product is unaffected', async () => {
    const v = await verifyAmazonListing('B0X', {
      fetcher: serve('Pokemon TCG Gardevoir ex League Battle Deck'),
      storedName: 'Pokemon TCG Gardevoir ex League Battle Deck',
    });
    assert.strictEqual(v.verdict, 'good');
  });

  test('the stock and inconclusive verdicts are untouched by this change', async () => {
    const oos = await verifyAmazonListing('B0X', {
      fetcher: async () => ({ item: { name: 'Pokemon TCG Booster Box' }, listings: [{ pinned_offer: true }] }),
      storedName: 'Pokemon TCG Booster Box',
    });
    assert.strictEqual(oos.verdict, 'no-stock');

    const blocked = await verifyAmazonListing('B0X', { fetcher: async () => null, storedName: 'anything' });
    assert.strictEqual(blocked.verdict, 'inconclusive');
  });
});

describe('the similarity metric itself', () => {
  test('containment, not jaccard — a long amazon title still matches a short stored name', () => {
    const stored = 'Pokemon TCG Gardevoir ex League Battle Deck';
    const live = 'Pokemon Trading Card Game TCG Gardevoir ex League Battle Deck, 60-Card Ready-to-Play '
      + 'Deck with Foil Promo Card, Damage Counters, Coin and Deck Box, Multicolour, Ages 6+';
    assert.ok(nameOverlap(stored, live) >= SAME_PRODUCT_OVERLAP,
      'jaccard would score this low purely because amazon titles are verbose — that is why it is containment');
  });

  test('it is symmetric enough not to depend on argument order', () => {
    const a = 'Pokemon TCG Booster Bundle Scarlet Violet';
    const b = 'Pokemon Trading Card Game Scarlet & Violet Booster Bundle 6 Packs';
    assert.strictEqual(nameOverlap(a, b).toFixed(2), nameOverlap(b, a).toFixed(2));
  });

  test('empty or missing input scores zero rather than throwing', () => {
    for (const [a, b] of [[null, 'x'], ['x', null], ['', ''], [undefined, undefined], ['-', '-']]) {
      assert.strictEqual(nameOverlap(a, b), 0);
    }
  });

  test('single characters do not inflate the score', () => {
    assert.strictEqual(nameOverlap('a b c', 'a b c d e f'), 0, 'tokens under 2 chars are dropped');
  });
});
