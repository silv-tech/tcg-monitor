/**
 * The confirmation guards must count REAL OBSERVATIONS, not poll ticks.
 *
 * THE CLASS OF BUG. Two guards exist to say "do not believe this until a second look agrees":
 * the out-of-stock confirmation (OOS_CONFIRM_POLLS) and the steep-price-drop hold. Both counted
 * POLLS. A poll is not a look. Adapters that keep a catalogue in memory re-emit every row they
 * did not refresh this sweep — amazon.js carries forward anything its rotation did not reach,
 * ebgames.js returns its whole _knownProducts — so the "second observation" was usually the
 * first one played back.
 *
 * Measured 2026-09-11 on ASIN B0H78BB9TY: the steep-drop hold was satisfied 0.37s after it
 * engaged, by the next 6s poll replaying the identical reading. Real reads of that ASIN were
 * ~238s apart, so a guard advertising "two independent observations" delivered 2.5 seconds of
 * protection and then published a -61% price drop on a product that had never been on sale. The
 * OOS confirmation had the same shape: 2 polls x 6s = 12 seconds.
 *
 * THE SIGNAL. lastSeen. Every genuine build stamps it; every carry-forward path copies the row
 * untouched. So a strictly newer lastSeen means somebody actually looked.
 *
 * WHY THIS FILE DRIVES THE REAL FUNCTION. The existing OOS and merge suites each reimplement
 * poll-adapter's logic in a local helper and assert against the copy. That is exactly why the
 * shared-object mutation bug shipped: the tests agreed with themselves while production
 * disagreed. Everything here calls the exported confirmObservation, so a test passing means the
 * shipped code did the thing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { confirmObservation } = require('../src/core/poll-adapter');

const T0 = 1_757_600_000_000;
const row = (over = {}) => ({
  sku: 'B0H78BB9TY',
  name: 'Pokemon TCG: 30th Celebration Elite Trainer Box',
  retailer: 'Amazon Canada',
  retailerId: 'amazon',
  inStock: true,
  price: 89.99,
  lastSeen: T0,
  ...over,
});
const confirm = (observed, prev) => confirmObservation(observed, prev, 'Amazon Canada', 'B0H78BB9TY');

describe('out-of-stock confirmation counts reads, not ticks', () => {
  test('a REPLAY of the same read does not advance the streak, and keeps holding', () => {
    // Poll 1: a genuine read says out of stock. Held, streak 1.
    const prev = row();
    const first = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), prev);
    assert.strictEqual(first._oosStreak, 1);
    assert.strictEqual(first.inStock, true, 'held — one observation is not enough');

    // Poll 2: the adapter carries the row forward untouched. Same lastSeen. NOT a new look.
    const replay = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), first);
    assert.strictEqual(replay._oosStreak, 1, 'a replay must not count as the second observation');
    assert.strictEqual(replay.inStock, true, 'and the hold must stay on');
  });

  test('no number of replays can ever confirm it', () => {
    let cur = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), row());
    for (let i = 0; i < 50; i++) {
      cur = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), cur);
    }
    assert.strictEqual(cur._oosStreak, 1, '50 polls, one read');
    assert.strictEqual(cur.inStock, true, 'this is the 12-second window that was not one');
  });

  test('a genuinely NEW read does confirm it', () => {
    const first = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), row());
    const second = confirm(row({ inStock: false, lastSeen: T0 + 240_000 }), first);

    assert.strictEqual(second._oosStreak, 2);
    assert.strictEqual(second.inStock, false, 'two independent reads agree — believe it');
  });

  test('replays between two real reads do not break the streak either', () => {
    let cur = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), row());
    for (let i = 0; i < 10; i++) cur = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), cur);
    cur = confirm(row({ inStock: false, lastSeen: T0 + 240_000 }), cur);

    assert.strictEqual(cur.inStock, false, 'the second real read still lands');
  });

  test('coming back into stock still fires on the FIRST observation', () => {
    // The whole point of confirming only the OOS direction: no restock is ever slowed.
    const oos = row({ inStock: false, lastSeen: T0, _oosStreak: 2 });
    const back = confirm(row({ inStock: true, lastSeen: T0 + 1000 }), oos);

    assert.strictEqual(back.inStock, true, 'restocks are a race and must not be held');
    assert.strictEqual(back._oosStreak, 0);
  });
});

describe('steep-drop hold counts reads, not ticks', () => {
  const pinned = (over) => row({ _pricePinned: true, ...over });

  test('THE INCIDENT: a replay must not confirm the drop 0.37s later', () => {
    const prev = pinned({ price: 200 });
    const held = confirm(pinned({ price: 80, lastSeen: T0 + 1000 }), prev);
    assert.strictEqual(held.price, 200, 'held');
    assert.strictEqual(held._steepDropStreak, 1);

    const replay = confirm(pinned({ price: 80, lastSeen: T0 + 1000 }), held);
    assert.strictEqual(replay._steepDropStreak, 1, 'the replay is not a second opinion');
    assert.strictEqual(replay.price, 200, 'so the drop stays held');
    assert.strictEqual(replay._priceHeld, true);
  });

  test('a real second read releases it', () => {
    const held = confirm(pinned({ price: 80, lastSeen: T0 + 1000 }), pinned({ price: 200 }));
    const real = confirm(pinned({ price: 80, lastSeen: T0 + 240_000 }), held);

    assert.strictEqual(real.price, 80, 'confirmed by an independent read');
    assert.strictEqual(real._steepDropStreak, 2);
    assert.strictEqual(real._priceHeld, undefined);
  });

  test('a price CORRECTION still bypasses the wait entirely', () => {
    // Unverified -> pinned is not a drop at all, so read-counting must not delay the true price.
    const next = confirm(row({ price: 89.99, _pricePinned: true, lastSeen: T0 + 1000 }),
      row({ price: 229, inStock: false }));

    assert.strictEqual(next.price, 89.99, 'the authoritative read is the truth, immediately');
    assert.strictEqual(next._priceCorrected, true);
    assert.strictEqual(next._priceHeld, undefined);
  });
});

describe('fails OPEN when the signal is absent', () => {
  // A row with no lastSeen must behave exactly as the old poll-counting code did. Failing closed
  // would pin inStock:true forever and make a sell-out unrecordable — which is what would have
  // happened to every Shopify shop's keyword-search lane, silently.
  test('neither side has lastSeen: behaves as before', () => {
    const prev = { inStock: true, price: 200 };
    const first = confirm({ inStock: false, price: 200 }, prev);
    assert.strictEqual(first._oosStreak, 1);
    assert.strictEqual(first.inStock, true);

    const second = confirm({ inStock: false, price: 200 }, first);
    assert.strictEqual(second._oosStreak, 2, 'must still be able to reach confirmation');
    assert.strictEqual(second.inStock, false, 'a sell-out MUST remain recordable');
  });

  test('only the previous row lacks it — the first poll after this deploy', () => {
    const prev = { inStock: true, price: 200 };                 // stored before lastSeen existed
    const first = confirm(row({ inStock: false, lastSeen: T0 }), prev);
    assert.strictEqual(first._oosStreak, 1, 'fails open, so the upgrade cannot strand a row');
    assert.strictEqual(first.inStock, true);

    // From here the row carries a timestamp, so the normal rule applies: the NEXT genuine read
    // confirms. (Re-presenting the same T0 would be a replay, and correctly would not.)
    const second = confirm(row({ inStock: false, lastSeen: T0 + 240_000 }), first);
    assert.strictEqual(second.inStock, false, 'no row may get stuck across the upgrade');
  });

  test('a non-numeric lastSeen is treated as absent, not as a comparison', () => {
    const prev = { inStock: true, price: 200, lastSeen: '2026-09-11T00:00:00Z' };
    const a = confirm({ inStock: false, price: 200, lastSeen: '2026-09-11T00:01:00Z' }, prev);
    const b = confirm({ inStock: false, price: 200, lastSeen: '2026-09-11T00:02:00Z' }, a);
    assert.strictEqual(b.inStock, false, 'string timestamps must not silently freeze the guard');
  });

  test('a BACKWARDS lastSeen is not a new read', () => {
    // Clock skew, or a cached row restored out of order. Strictly-newer, never merely-different.
    const first = confirm(row({ inStock: false, lastSeen: T0 + 1000 }), row());
    const back = confirm(row({ inStock: false, lastSeen: T0 - 5000 }), first);
    assert.strictEqual(back._oosStreak, 1, 'time going backwards is not evidence');
    assert.strictEqual(back.inStock, true);
  });
});

describe('purity — poll-adapter never writes into an adapter catalogue', () => {
  test('the observed object is not mutated', () => {
    const observed = row({ inStock: false, price: 80, lastSeen: T0 + 1000 });
    const snapshot = JSON.stringify(observed);
    const out = confirm(observed, row({ price: 200 }));

    assert.strictEqual(JSON.stringify(observed), snapshot,
      'EB Games returned its live objects; a hold written into one became its next observation');
    assert.notStrictEqual(out, observed, 'a copy, always');
  });

  test('the previous object is not mutated', () => {
    const prev = row({ price: 200, _pricePinned: true });
    const snapshot = JSON.stringify(prev);
    confirm(row({ price: 80, _pricePinned: true, lastSeen: T0 + 1000 }), prev);
    assert.strictEqual(JSON.stringify(prev), snapshot);
  });

  test('a first sighting is returned as a copy too', () => {
    const observed = row();
    const out = confirm(observed, undefined);
    assert.notStrictEqual(out, observed, 'delivery writes _offerId into this object');
    assert.deepStrictEqual(out, observed);
  });
});

describe('the Shopify search lane supplies the signal', () => {
  /**
   * This lane deliberately skips classify() — classify() also sets category='other' when no
   * franchise word is found, and routeEvent permanently BLOCKS 'other', which would silence real
   * in-stock Pokemon products. So it had to stamp lastSeen by hand.
   *
   * THE FREEZE IT PREVENTS is subtler than "the field is missing". A missing lastSeen fails open
   * and behaves exactly as the old poll-counting code did. The danger is the SPREAD: this lane
   * builds rows as `{ ...(existing || {}), ... }`, so a product the page-1 sweep classified once
   * INHERITS that sweep's timestamp and, without a re-stamp, carries it unchanged forever. Two
   * consecutive polls then show an identical numeric lastSeen, the guard reads "replay", the
   * out-of-stock hold pins inStock:true permanently, and that shop can never record a sell-out.
   *
   * Every other spread-from-cache builder in the codebase (amazon.js x4, ebgames.js via
   * classify(), bot.js x2) re-stamps after the spread. This was the only one that did not.
   */
  const ShopifyAdapter = require('../src/adapters/shopify');

  const makeAdapter = (available = false) => {
    const a = new ShopifyAdapter({
      id: 'titantoyz', name: 'Titan Toyz', url: 'https://titantoyz.com',
      intervalMs: 60000, collections: [], searchTerms: ['pokemon'],
    });
    a._handleToSku.set('prismatic-etb', 'PRIS-ETB');   // the lane no-ops until identity is known
    a.stock = available;
    a._fetchPage = async () => ({
      products: [{
        title: 'Pokemon TCG Prismatic Evolutions Elite Trainer Box',
        handle: 'prismatic-etb', sku: 'PRIS-ETB', available: a.stock, price: 6999,
        featured_image: { url: 'https://example.test/x.jpg' },
      }],
    });
    return a;
  };
  const tick = () => new Promise((r) => setTimeout(r, 2));   // Date.now() must strictly advance

  test('a row it refreshes carries a FRESH numeric lastSeen', async () => {
    const a = makeAdapter();
    const products = {};
    await a._searchProducts(products);

    const row0 = products['PRIS-ETB'];
    assert.ok(row0, 'the lane must have refreshed the row');
    assert.strictEqual(typeof row0.lastSeen, 'number');
    assert.ok(row0.lastSeen > T0, 'and it must be now, not some inherited moment');
  });

  test('it does NOT inherit a stale timestamp from the page-1 sweep', async () => {
    const a = makeAdapter();
    const swept = { sku: 'PRIS-ETB', name: 'x', inStock: true, price: 69.99, lastSeen: T0 };
    const products = { 'PRIS-ETB': swept };
    await a._searchProducts(products);

    assert.notStrictEqual(products['PRIS-ETB'].lastSeen, T0,
      'inheriting the sweep timestamp is the freeze: the guard would see a replay forever');
  });

  test('end to end: an off-page-1 product CAN still be confirmed out of stock', async () => {
    // The regression this whole describe block exists to prevent, driven through both real units:
    // the adapter's search lane builds each row, confirmObservation judges it.
    const a = makeAdapter(true);

    /** One poll: the lane refreshes the stored row, then the guard rules on it. */
    const poll = async (prev) => {
      const products = prev ? { 'PRIS-ETB': { ...prev } } : {};
      await a._searchProducts(products);
      return confirmObservation(products['PRIS-ETB'], prev, 'Titan Toyz', 'PRIS-ETB');
    };

    let cur = await poll(undefined);
    assert.strictEqual(cur.inStock, true, 'starts in stock');

    a.stock = false;                    // it sells out
    await tick();
    cur = await poll(cur);
    assert.strictEqual(cur.inStock, true, 'one observation is not enough — correctly held');
    assert.strictEqual(cur._oosStreak, 1);

    await tick();
    cur = await poll(cur);
    assert.strictEqual(cur._oosStreak, 2, 'the second GENUINE read must count');
    assert.strictEqual(cur.inStock, false,
      'a sell-out MUST remain recordable on every enabled Shopify shop');
  });
});
