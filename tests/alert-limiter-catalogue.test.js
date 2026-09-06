/**
 * The outbound ceiling has to scale with catalogue size.
 *
 * A flat 12/min meant opposite things at opposite ends of the shop list — measured against the
 * live catalogues it was 0.05% of pokejeux (24,471 products, 17,824 in stock) and 46% of
 * London Drugs (26 products). The consequence was the one failure mode that matters most: it
 * muted a GENUINE sale at remicardtrader (4,497 products, 1,970 in stock) and dropped ten
 * minutes of real restocks.
 *
 * The rule can only ever raise a ceiling. That is asserted here directly, because a change
 * that quietly tightened any store would trade a known bug for a silent one.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const limiter = require('../src/discord/alert-limiter');

const ev = (retailerId, name = 'Pokemon TCG Booster Bundle') =>
  ({ type: 'RESTOCK', product: { retailerId, name, sku: name } });

beforeEach(() => {
  limiter.reset();
  limiter.setRecoverHandler(null);
  limiter.setTripHandler(null);
});

describe('ceiling scales with catalogue size', () => {
  test('a large Shopify shop gets real headroom', () => {
    limiter.setCatalogueSize('remicardtrader', 4497);
    assert.strictEqual(limiter.limitFor('remicardtrader'), 90);
  });

  test('an enormous catalogue is capped, so a true runaway is still contained', () => {
    limiter.setCatalogueSize('pokejeux', 24471);
    assert.strictEqual(limiter.limitFor('pokejeux'), limiter.MAX_LIMIT);
  });

  test('a tiny catalogue keeps a usable floor rather than a 2% ceiling of 1', () => {
    limiter.setCatalogueSize('londondrugs', 26);
    assert.strictEqual(limiter.limitFor('londondrugs'), limiter.MIN_LIMIT);
  });

  test('an explicit override still wins when it is higher', () => {
    limiter.setCatalogueSize('walmart', 169);   // 2% = 4, floor 15, override 25
    assert.strictEqual(limiter.limitFor('walmart'), 25);
  });

  test('no retailer ends up with a LOWER ceiling than before', () => {
    const sizes = { pokejeux: 24471, infinitycards: 19444, deckoutgaming: 9261, doescards: 6266,
      remicardtrader: 4497, zardocards: 4106, kanzengames: 3936, '401games': 3050,
      gameshack: 2567, hobbiesville: 2335, pokemoncenter: 1195, chimeragaming: 1029,
      ebgames: 801, bestbuy: 270, amazon: 216, walmart: 169, costco: 48, londondrugs: 26 };
    for (const [id, n] of Object.entries(sizes)) {
      const before = limiter.LIMITS[id] || limiter.DEFAULT_MAX_PER_WINDOW;
      limiter.setCatalogueSize(id, n);
      assert.ok(limiter.limitFor(id) >= before,
        `${id}: ${limiter.limitFor(id)} must not be below the previous ${before}`);
    }
  });
});

describe('the reported failure no longer happens', () => {
  test('remicardtrader survives a 40-alert genuine sale', () => {
    limiter.setCatalogueSize('remicardtrader', 4497);
    let allowed = 0;
    for (let i = 0; i < 40; i++) if (limiter.allow(ev('remicardtrader', `Product ${i}`)).allowed) allowed++;
    assert.strictEqual(allowed, 40, 'a real sale of 40 products must not trip the limiter');
  });

  test('but a catalogue-wide regression is still caught', () => {
    limiter.setCatalogueSize('remicardtrader', 4497);
    let blocked = 0;
    for (let i = 0; i < 400; i++) if (!limiter.allow(ev('remicardtrader', `Product ${i}`)).allowed) blocked++;
    assert.ok(blocked > 250, `a 400-alert flood must still be contained (blocked ${blocked})`);
  });
});

describe('a mute reports what it dropped', () => {
  test('recovery hands back the suppressed product names', () => {
    limiter.setCatalogueSize('tinyshop', 1);   // floor 15
    const seen = [];
    limiter.setRecoverHandler((id, info) => seen.push({ id, ...info }));

    for (let i = 0; i < 30; i++) limiter.allow(ev('tinyshop', `Dropped ${i}`));
    assert.strictEqual(seen.length, 0, 'nothing reported while still muted');

    // Reach past the cooldown without waiting on a real clock.
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try { limiter.allow(ev('tinyshop', 'After cooldown')); } finally { Date.now = realNow; }

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].id, 'tinyshop');
    assert.ok(seen[0].suppressed > 0);
    assert.ok(seen[0].products.length > 0, 'the dropped products must be visible');
    assert.ok(seen[0].products.every((p) => typeof p === 'string'));
  });

  test('watchlist alerts are never suppressed', () => {
    limiter.setCatalogueSize('tinyshop', 1);
    for (let i = 0; i < 50; i++) limiter.allow(ev('tinyshop', `Flood ${i}`));
    const watch = { type: 'RESTOCK', product: { retailerId: 'tinyshop', name: 'Watched', _watchlist: true } };
    assert.strictEqual(limiter.allow(watch).allowed, true);
  });
});
