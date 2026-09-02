/**
 * Comprehensive OOS Filter Test
 * Tests both layers: deliver() filter + routeEvent() safety guard
 * Verifies no OOS alert can reach Discord under any combination of event type + stock status.
 */

// ─── Mock dependencies ───────────────────────────────────────────
const sentAlerts = [];
const blockedAlerts = [];
const logMessages = [];

// Mock logger
const logger = {
  info: (msg) => logMessages.push(`INFO: ${msg}`),
  warn: (msg) => logMessages.push(`WARN: ${msg}`),
  error: (msg) => logMessages.push(`ERROR: ${msg}`),
  debug: (msg) => logMessages.push(`DEBUG: ${msg}`),
};

// Intercept require calls
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
const mockModules = {
  '../config': {
    discord: { paidChannelId: 'test-paid', freeChannelId: 'test-free', adminChannelId: 'test-admin' },
    delivery: { freeTierDelayMs: 0 },
    proxy: {},
  },
  '../monitoring/logger': logger,
  './embeds': {
    buildAlertEmbed: (event, tier) => ({
      embed: { title: event.product?.name, tier },
      components: [],
    }),
  },
  './dedup': {
    filterDuplicates: async (events) => events,
    markSent: async () => {},
  },
  '../core/proxy': {
    recordAlertLatency: () => {},
  },
  '../core/state': {
    getRestockHistory: async () => [],
    findCrossRetailerMatches: async () => [],
    getLastCheck: async () => null,
    getPriceHistory: async () => [],
    getOfferListingId: async () => null,
    cacheOfferListingId: async () => {},
    getSellerCache: async () => null,
    cacheSellerInfo: async () => {},
  },
  '../utils/browser': {
    scrapeAmazonOfferListingId: async () => ({ olid: null, seller: null }),
  },
  '../utils/scraper-api': {
    fetchAmazonOlidAndSeller: async () => ({ olid: null, seller: null }),
  },
  '../utils/helpers': {
    sleep: async () => {},
  },
  '../config/channels.json': {
    tiers: { free: { enabled: false }, paid: { channels: { default: 'test-paid' } } },
    enabledEvents: {},
  },
};

// Override require for delivery.js dependencies
Module._resolveFilename = function (request, parent, ...args) {
  if (parent && parent.filename && parent.filename.includes('delivery') && mockModules[request]) {
    return request;
  }
  return originalResolveFilename.call(this, request, parent, ...args);
};

const originalLoad = Module._load;
Module._load = function (request, parent, ...args) {
  if (parent && parent.filename && parent.filename.includes('delivery') && mockModules[request]) {
    return mockModules[request];
  }
  return originalLoad.call(this, request, parent, ...args);
};

// Now require delivery
const path = require('path');
const deliveryPath = path.resolve(__dirname, '../src/discord/delivery.js');

// Clear cache so our mocks take effect
delete require.cache[deliveryPath];
const delivery = require(deliveryPath);

// Override sendToChannel to track what would be sent
delivery.sendToChannel = async (channelId, embed, components, content, tier) => {
  sentAlerts.push({ channelId, embed, content, tier });
};

// Override enrichEvent to skip network calls
delivery.enrichEvent = async () => {};

// ─── Test helpers ────────────────────────────────────────────────
function makeEvent(type, inStock, extra = {}) {
  return {
    type,
    product: {
      name: `Test ${type} Product`,
      sku: 'TEST-SKU-001',
      price: 49.99,
      retailer: 'Test Store',
      retailerId: 'teststore',
      category: 'pokemon',
      inStock,
      canAddToCart: inStock,
      isTCG: true,
      url: 'https://example.com/product',
      ...extra,
    },
    ...(type === 'PRICE_CHANGE' ? { oldValue: 59.99, newValue: 49.99 } : {}),
    ...extra._eventProps,
  };
}

async function testCase(label, events, expectSent, expectBlocked) {
  sentAlerts.length = 0;
  logMessages.length = 0;

  await delivery.deliver(events, { skipDedup: true });

  // Wait for processQueue to finish
  await new Promise(r => setTimeout(r, 200));

  const passed = sentAlerts.length === expectSent;
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${label} — sent: ${sentAlerts.length} (expected ${expectSent})`);

  if (!passed) {
    console.log(`   Alerts sent:`, sentAlerts.map(a => `${a.embed?.title} to ${a.channelId}`));
    console.log(`   Log messages:`, logMessages.filter(m => m.includes('OOS') || m.includes('filtered')));
  }

  return passed;
}

// ─── Run all tests ───────────────────────────────────────────────
async function runTests() {
  console.log('\n════════════════════════════════════════════════════');
  console.log('  OOS FILTER TEST — BOTH LAYERS');
  console.log('════════════════════════════════════════════════════\n');

  let pass = 0;
  let fail = 0;

  async function run(label, events, expectSent) {
    const ok = await testCase(label, events, expectSent);
    if (ok) pass++;
    else fail++;
  }

  // ─── Layer 1: deliver() filter tests ───────────────────────────
  console.log('── deliver() filter (first layer) ──\n');

  // In-stock events SHOULD send
  await run('RESTOCK inStock=true → SEND', [makeEvent('RESTOCK', true)], 1);
  await run('NEW_SKU inStock=true → SEND', [makeEvent('NEW_SKU', true)], 1);
  await run('PRICE_CHANGE inStock=true → SEND', [makeEvent('PRICE_CHANGE', true)], 1);
  await run('CART_AVAILABLE inStock=true → SEND', [makeEvent('CART_AVAILABLE', true)], 1);
  await run('SHIPPING_CHANGE inStock=true → SEND', [makeEvent('SHIPPING_CHANGE', true)], 1);
  await run('PREORDER_LIVE inStock=false → SEND (exempt)', [makeEvent('PREORDER_LIVE', false)], 1);
  await run('RESTOCK inStock=true (by definition) → SEND (exempt)', [makeEvent('RESTOCK', true)], 1);

  console.log('');

  // OOS events SHOULD NOT send
  await run('NEW_SKU inStock=false → BLOCKED', [makeEvent('NEW_SKU', false)], 0);
  await run('PRICE_CHANGE inStock=false → BLOCKED', [makeEvent('PRICE_CHANGE', false)], 0);
  await run('CART_AVAILABLE inStock=false → BLOCKED', [makeEvent('CART_AVAILABLE', false)], 0);
  await run('SHIPPING_CHANGE inStock=false → BLOCKED', [makeEvent('SHIPPING_CHANGE', false)], 0);

  console.log('');

  // Edge cases: undefined, null, 0 for inStock
  await run('NEW_SKU inStock=undefined → BLOCKED', [makeEvent('NEW_SKU', undefined)], 0);
  await run('NEW_SKU inStock=null → BLOCKED', [makeEvent('NEW_SKU', null)], 0);
  await run('NEW_SKU inStock=0 → BLOCKED', [makeEvent('NEW_SKU', 0)], 0);
  await run('NEW_SKU inStock="" → BLOCKED', [makeEvent('NEW_SKU', '')], 0);
  await run('PRICE_CHANGE inStock=undefined → BLOCKED', [makeEvent('PRICE_CHANGE', undefined)], 0);
  await run('PRICE_CHANGE inStock=null → BLOCKED', [makeEvent('PRICE_CHANGE', null)], 0);

  console.log('');

  // ─── Layer 2: routeEvent() safety guard ────────────────────────
  console.log('── routeEvent() safety guard (second layer) ──\n');

  // Scan events bypass both filters (admin utility)
  await run('Scan event inStock=false → SEND (admin bypass)', [
    { ...makeEvent('LISTING', false), _scanTier: 'scan' },
  ], 1);
  await run('Scan event inStock=undefined → SEND (admin bypass)', [
    { ...makeEvent('LISTING', undefined), _scanTier: 'scan' },
  ], 1);

  console.log('');

  // ─── Additional filters ────────────────────────────────────────
  console.log('── Other delivery filters ──\n');

  // No price → blocked
  await run('No price (null) → BLOCKED', [makeEvent('NEW_SKU', true, { price: null })], 0);
  await run('No price (0) → BLOCKED', [makeEvent('NEW_SKU', true, { price: 0 })], 0);
  await run('Negative price → BLOCKED', [makeEvent('NEW_SKU', true, { price: -5 })], 0);

  // Low price → blocked
  await run('Low price ($5) → BLOCKED', [makeEvent('NEW_SKU', true, { price: 5 })], 0);
  await run('Low price ($14.99) → BLOCKED', [makeEvent('NEW_SKU', true, { price: 14.99 })], 0);
  await run('At minimum ($15) → SEND', [makeEvent('NEW_SKU', true, { price: 15 })], 1);

  // Non-TCG → blocked
  await run('Non-TCG product → BLOCKED', [makeEvent('NEW_SKU', true, { isTCG: false })], 0);

  console.log('');

  // ─── Batch / mixed scenarios ───────────────────────────────────
  console.log('── Batch scenarios ──\n');

  await run('Mix: 1 inStock + 1 OOS → only 1 SENT', [
    makeEvent('RESTOCK', true),
    makeEvent('NEW_SKU', false),
  ], 1);

  await run('Mix: 2 inStock + 3 OOS → only 2 SENT', [
    makeEvent('RESTOCK', true),
    makeEvent('PRICE_CHANGE', true),
    makeEvent('NEW_SKU', false),
    makeEvent('CART_AVAILABLE', null),
    makeEvent('SHIPPING_CHANGE', undefined),
  ], 2);

  await run('All OOS → 0 SENT', [
    makeEvent('NEW_SKU', false),
    makeEvent('PRICE_CHANGE', null),
    makeEvent('CART_AVAILABLE', undefined),
    makeEvent('SHIPPING_CHANGE', 0),
  ], 0);

  // ─── Summary ───────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${pass} passed, ${fail} failed out of ${pass + fail} tests`);
  console.log('════════════════════════════════════════════════════\n');

  // Restore module hooks
  Module._resolveFilename = originalResolveFilename;
  Module._load = originalLoad;

  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
