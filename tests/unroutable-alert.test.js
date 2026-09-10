/**
 * An alert we cannot route must cost us ONE alert, not every alert for that product forever.
 *
 * Measured in production 2026-09-10, repeating every ~3m18s:
 *
 *   [ERRO] Failed to send alert error="Cannot read properties of undefined (reading 'toLowerCase')"
 *          sku="8420675879075-44558244216995" type="RESTOCK"
 *
 * `retailerIdFromName` ended in `retailerName.toLowerCase()`, which throws TypeError when a product
 * carries no retailer name. The throw escaped routeEvent into processQueue's catch — and that catch
 * skips `markSent`. So dedup never recorded the event, the next poll re-detected the same RESTOCK,
 * and it crashed again. Permanently undeliverable AND permanently retried: the product could never
 * alert, and the failure repeated for the life of the process.
 *
 * 150 of 515 stored Titan Toyz rows carry neither `retailerId` nor `retailer`, so this was not an
 * exotic edge case — it was 29% of one store's catalogue waiting to hit it. Both observed victims
 * were real in-scope Dragon Ball products for that store.
 *
 * Two properties are pinned here, and the second is the one that made this permanent:
 *   1. a product with no retailer name does not crash, and IS delivered when the URL can supply one
 *   2. a genuinely unroutable product returns normally, so markSent runs and the loop cannot form
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;
state.getRestockHistory = async () => [];
state.getPriceHistory = async () => [];
state.findCrossRetailerMatches = async () => [];
state.getLastCheck = async () => Date.now();
state.getOfferListingId = async () => 'TEST_OLID_0000000000';
state.getSellerCache = async () => 'Amazon.ca';
state.cacheOfferListingId = async () => {};
state.cacheSellerInfo = async () => {};
state.getStoreCategories = async () => null;
state.getActiveCategories = async () => ['default'];

const delivery = require('../src/discord/delivery');

const realEnrich = delivery.enrichEvent;
let sent = [];

beforeEach(() => {
  sent = [];
  delivery.enrichEvent = async () => {};
  delivery.sendToChannel = async (channelId, embed) => { sent.push({ channelId, embed }); return true; };
  delivery.resolvePaidChannel = (category, retailerId) => `CH_${retailerId}`;
  delivery.resolveFreeChannel = () => null;
});

afterEach(() => { delivery.enrichEvent = realEnrich; });

const ev = (over = {}) => ({
  type: 'RESTOCK',
  _detectedAt: Date.now(),
  product: {
    sku: '8420675879075-44558244216995',
    name: 'Dragon Ball Super Card Game Fusion World Booster Pack Raging Roar FB03 :Box(24packs)',
    price: 69.99, inStock: true, category: 'default',
    url: 'https://www.titantoyz.com/products/dragon-ball-super-fusion-world-fb03',
    ...over,
  },
});

describe('the exact production crash', () => {
  test('retailerIdFromName does not throw on a missing name', () => {
    for (const bad of [undefined, null, '', 0, false, {}, []]) {
      assert.doesNotThrow(() => delivery.retailerIdFromName(bad), `threw on ${JSON.stringify(bad)}`);
      assert.strictEqual(delivery.retailerIdFromName(bad), null);
    }
  });

  test('it still maps the known display names it was written for', () => {
    assert.strictEqual(delivery.retailerIdFromName('EB Games'), 'ebgames');
    assert.strictEqual(delivery.retailerIdFromName('Best Buy Canada'), 'bestbuy');
    assert.strictEqual(delivery.retailerIdFromName('Walmart Canada'), 'walmart');
    assert.strictEqual(delivery.retailerIdFromName('Some New Shop'), 'somenewshop');
  });

  test('routeEvent no longer throws on the real product that was crashing', async () => {
    await assert.doesNotReject(() => delivery.routeEvent(ev({ retailerId: undefined, retailer: undefined }), Date.now()));
  });
});

describe('the alert is recovered, not merely survived', () => {
  test('the retailer is read off the product url when both fields are missing', async () => {
    await delivery.routeEvent(ev({ retailerId: undefined, retailer: undefined }), Date.now());
    assert.ok(sent.length > 0, 'the alert must actually be delivered, not just not-crash');
    assert.strictEqual(sent[0].channelId, 'CH_titantoyz', 'and to the right store channel');
  });

  test('retailerIdFromUrl handles the shapes a stored url can take', () => {
    assert.strictEqual(delivery.retailerIdFromUrl('https://www.titantoyz.com/products/x'), 'titantoyz');
    assert.strictEqual(delivery.retailerIdFromUrl('https://store.401games.ca/a/b'), 'store');
    assert.strictEqual(delivery.retailerIdFromUrl('not a url'), null);
    assert.strictEqual(delivery.retailerIdFromUrl(undefined), null);
    assert.strictEqual(delivery.retailerIdFromUrl(''), null);
  });

  test('the display name the embed requires is recovered from config', async () => {
    const e = ev({ retailerId: undefined, retailer: undefined });
    await delivery.routeEvent(e, Date.now());
    assert.strictEqual(e.product.retailer, 'Titan Toyz',
      'embeds.js does setAuthor({name: product.retailer}) and discord.js rejects undefined — '
      + 'fixing only the id moves the crash into embed construction instead of removing it');
  });

  test('an unknown retailer id still yields a usable name rather than undefined', async () => {
    const e = ev({ retailerId: undefined, retailer: undefined, url: 'https://www.brandnewshop.ca/p/1' });
    await delivery.routeEvent(e, Date.now());
    assert.strictEqual(typeof e.product.retailer, 'string');
    assert.ok(e.product.retailer.length > 0, 'any non-empty name beats a lost alert');
  });

  test('an explicit retailerId still wins over the url', async () => {
    await delivery.routeEvent(ev({ retailerId: 'titantoyz', retailer: undefined }), Date.now());
    assert.strictEqual(sent[0].channelId, 'CH_titantoyz');
  });
});

describe('a genuinely unroutable alert cannot become an infinite loop', () => {
  test('it returns instead of throwing, so processQueue reaches markSent', async () => {
    const e = ev({ retailerId: undefined, retailer: undefined, url: undefined });
    await assert.doesNotReject(() => delivery.routeEvent(e, Date.now()),
      'a throw here skips markSent, and the same event is retried and re-thrown every poll forever');
    assert.strictEqual(sent.length, 0, 'nothing to route means nothing is sent');
  });

  test('the loss is recorded so it can be audited afterwards', async () => {
    const logger = require('../src/monitoring/logger');
    const realWarn = logger.warn;
    const lines = [];
    logger.warn = (msg) => { lines.push(String(msg)); };
    try {
      await delivery.routeEvent(ev({ retailerId: undefined, retailer: undefined, url: undefined }), Date.now());
    } finally {
      logger.warn = realWarn;
    }
    const lost = lines.find((l) => l.includes('ALERT LOST'));
    assert.ok(lost, 'an unroutable alert must be recorded, not dropped in silence');
    assert.match(lost, /8420675879075/, 'and must name the sku so it can be chased by hand');
  });
});
