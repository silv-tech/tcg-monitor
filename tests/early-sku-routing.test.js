/**
 * An EARLY_SKU alert must survive BOTH out-of-stock guards, because it is by definition a product
 * that has appeared before it is buyable.
 *
 * THE DEFECT: the same rule is implemented twice with different exemption lists.
 *
 *   delivery.js deliver()     exempt: RESTOCK, PREORDER_LIVE, EARLY_SKU, _scanTier
 *   delivery.js routeEvent()  exempt: RESTOCK, PREORDER_LIVE,            _scanTier
 *
 * `deliver()` deliberately waves an out-of-stock EARLY_SKU through — the comment above it names
 * EARLY_SKU explicitly — and then `routeEvent()`, described in its own comment as "defense in
 * depth", kills it. A sitemap-discovered product has no stock and no price by construction, so
 * EVERY early-listing alert is blocked at the final step.
 *
 * WHY THIS MATTERS NOW: the Pokemon Center sitemap lane runs every 12h from Railway, free, and
 * enumerates the whole store — live, today:
 *
 *     Early SKU [Pokemon Center]: 34593 product URLs
 *     Early SKU [Pokemon Center]: 2.8s — 0 new URLs, 0 TCG
 *
 * Catalogue discovery for all 8,415 SKUs is already solved and costs nothing. New-listing alerting
 * is not, and this guard is one of the reasons: even once a new URL IS found, the alert cannot be
 * delivered. The same block applies to Walmart's early-SKU lane.
 *
 * The fix is to make the second copy of the rule agree with the first, not to weaken either.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
const logger = require('../src/monitoring/logger');

// Capture the guard's own warn line — that is the only unambiguous signal that it fired.
const warnings = [];
const origWarn = logger.warn;
logger.warn = (...a) => { warnings.push(String(a[0])); return origWarn.apply(logger, a); };

// Stub the store BEFORE delivery is required — it destructures its helpers at import time, and a
// real ioredis handle hangs `node --test` indefinitely.
state.getRestockHistory = async () => [];
state.getPriceHistory = async () => [];
state.findCrossRetailerMatches = async () => [];
state.getLastCheck = async () => Date.now();
state.getOfferListingId = async () => null;
state.cacheOfferListingId = async () => {};
state.getSellerCache = async () => null;
state.getSellerCacheAgeMs = async () => null;
state.cacheSellerInfo = async () => {};
state.getActiveCategories = async () => null;

const delivery = require('../src/discord/delivery');

const earlyEvent = (over = {}) => ({
  type: 'EARLY_SKU',
  product: {
    sku: '699-12345',
    name: 'Pokémon Center Exclusive Plush — New Listing',
    retailerId: 'pokemoncenter',
    retailer: 'Pokemon Center',
    url: 'https://www.pokemoncenter.com/en-ca/product/699-12345',
    inStock: false,      // by definition: discovered from a sitemap, never checked
    price: null,
    category: 'pokemon',
    isTCG: true,
    ...over,
  },
});

describe('an out-of-stock EARLY_SKU reaches routing', () => {
  let sent;
  let origRoute;

  beforeEach(() => {
    sent = [];
    origRoute = delivery.routeEvent;
  });

  test('routeEvent does not block it — deliver() already exempted it', async () => {
    // The guard is the ONLY thing that emits "OOS guard (routeEvent)". If that line appears, the
    // event was killed there; everything downstream may fail in a test process and is irrelevant.
    warnings.length = 0;
    try {
      await delivery.routeEvent(earlyEvent());
    } catch { /* channel resolution may fail here; the guard runs long before it */ }

    const blocked = warnings.filter((w) => w.includes('OOS guard (routeEvent)'));
    assert.deepStrictEqual(blocked, [],
      'routeEvent blocked an out-of-stock EARLY_SKU that deliver() deliberately let through — '
      + 'a sitemap-discovered product has no stock by construction, so this kills every one');
  });

  test('an out-of-stock NEW_SKU IS still blocked there — the guard still works', async () => {
    warnings.length = 0;
    const e = earlyEvent();
    e.type = 'NEW_SKU';
    try { await delivery.routeEvent(e); } catch { /* as above */ }

    assert.ok(warnings.some((w) => w.includes('OOS guard (routeEvent)')),
      'the guard must keep blocking types that were never exempt');
  });

  test('the two guards agree on their exemption lists', () => {
    // A rule implemented twice with different exemptions is the defect itself. Pin them together
    // so the next person to add an exempt type cannot update only one copy.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');

    const deliverGuard = src.slice(src.indexOf('// Skip out-of-stock products'),
      src.indexOf('// Skip products with no price'));
    const routeGuard = src.slice(src.indexOf('// Catches anything that slipped past'),
      src.indexOf('// A CONFIRMED wrong identity'));

    const types = (s) => (s.match(/'(RESTOCK|PREORDER_LIVE|EARLY_SKU)'/g) || [])
      .map((x) => x.replace(/'/g, '')).sort();

    assert.deepStrictEqual(types(routeGuard), types(deliverGuard),
      'deliver() and routeEvent() exempt different event types from the same out-of-stock rule');
  });

  test('a genuinely out-of-stock NEW_SKU is still blocked', () => {
    // The guard must keep doing its job for every type that was never exempt.
    const src = require('fs').readFileSync(require.resolve('../src/discord/delivery'), 'utf8');
    const routeGuard = src.slice(src.indexOf('// Catches anything that slipped past'),
      src.indexOf('// A CONFIRMED wrong identity'));
    assert.ok(!routeGuard.includes("'NEW_SKU'"),
      'NEW_SKU must NOT become exempt — it is not an availability transition');
    assert.match(routeGuard, /OOS guard \(routeEvent\)/, 'and the guard must still exist');
  });
});
