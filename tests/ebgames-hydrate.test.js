/**
 * EB Games must reload its catalogue from Redis on startup.
 *
 * `_knownProducts` is in-memory only, and in push mode the adapter CANNOT rebuild it on its
 * own: it refills one category page per ~25s as the extension walks the pager, so a full sweep
 * takes 6-16 minutes. Redis still holds all ~234 products the whole time.
 *
 * Without hydration, poll-adapter compares a nearly-empty map against a full one. Its only
 * guard is `newCount < oldCount * 0.3`, which a refilling cache crosses on the third page —
 * after which the ~70% not yet swept are marked out of stock, and every page the sweep then
 * reaches fires a RESTOCK for products that never moved.
 *
 * Measured live 2026-09-10, 9h13m across 20 restarts:
 *   436 RESTOCK alerts over just 49 SKUs — every SKU 5-19 times, none once
 *   78.7% within ten minutes of a process start
 *   repeats as close as 14 seconds apart
 *   all 628 stale-cleanup sweeps ran within ten minutes of a restart; none later
 *
 * ccba1cf fixed exactly this for Amazon and recorded that "Shopify and EB Games already did
 * this". Shopify does (_loadHandleIndex); EB Games never did, so it was skipped — which is
 * what these tests exist to stop happening again.
 *
 * Confirmation goes through the REAL ingestPushed(), not a hand-rolled _merge: an earlier
 * version of this file re-implemented the confirm step, so deleting the production line would
 * have left every test green.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const state = require('../src/core/state');
const EBGamesAdapter = require('../src/adapters/ebgames');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/ebgames-category.html'), 'utf8');
const CARD_RE = /<form role="article"[^>]*\boe_product_cart\b[^>]*>[\s\S]*?<\/form>/g;
const SAMPLE_CARD = FIXTURE.match(CARD_RE)[0];      // real markup, SKU 790420
const ACCESSORY = 'Ultra Pro Pro-Binder 9-Pocket Portfolio Black';

// Build a real category page carrying the given SKUs, by restamping genuine card markup.
// Parsing stays the production parser's job — only the SKU is substituted.
function pageOf(skus) {
  const cards = skus.map((sku) => SAMPLE_CARD.split('790420').join(String(sku))).join('\n');
  return `<html><body><div class="oe_website_sale">${cards}</div>${'<!-- pad -->'.repeat(200)}</body></html>`;
}

const SKUS = Array.from({ length: 20 }, (_, i) => String(900001 + i));

const row = (sku, over = {}) => ({
  sku,
  name: 'Pokémon Trading Card Game 2024 Trick or Trade B00ster Bundle',
  price: 29.99, inStock: true, canAddToCart: true,
  retailerId: 'ebgames', retailer: 'EB Games', lastSeen: Date.now() - 600000, ...over,
});

const catalogue = (skus = SKUS) => Object.fromEntries(skus.map((s) => [s, row(s)]));

const realGetAllProducts = state.getAllProducts;
afterEach(() => { state.getAllProducts = realGetAllProducts; });

function adapter() {
  const a = new EBGamesAdapter({
    id: 'ebgames', name: 'EB Games', url: 'https://www.ebgames.ca', intervalMs: 5000,
  });
  a.pushOnly = true;
  a._seedRedis = async () => {};
  a._fetchListing = async () => { throw new Error('push mode must not fetch'); };
  a._deepCrawl = async () => { throw new Error('push mode must not crawl'); };
  return a;
}

describe('startup: the catalogue is restored before the sweep can refill it', () => {
  test('the very first poll reports the whole stored catalogue, not an empty one', async () => {
    state.getAllProducts = async () => catalogue();
    const a = adapter();

    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 20,
      'an empty first poll is what poll-adapter reads as a mass delisting');
    assert.strictEqual(products['900001'].inStock, true, 'stored stock comes back with it');
  });

  test('it runs once per process while it keeps succeeding', async () => {
    let calls = 0;
    state.getAllProducts = async () => { calls++; return catalogue(['900001']); };
    const a = adapter();

    await a.fetchProducts();
    await a.fetchProducts();
    await a.fetchProducts();
    assert.strictEqual(calls, 1, 'hydration is a startup step, not a per-poll Redis read');
  });

  test('rows the scope rule now rejects are not re-admitted', async () => {
    state.getAllProducts = async () => ({
      900001: row('900001'), 900002: row('900002', { name: ACCESSORY }),
    });
    const a = adapter();

    const products = await a.fetchProducts();
    assert.deepStrictEqual(Object.keys(products), ['900001'],
      'Redis holds rows written before scope was centralised; hydration must not undo that');
  });

  test('a row with no name is skipped rather than guessed at', async () => {
    state.getAllProducts = async () => ({ 900001: row('900001'), 900002: { sku: '900002' } });
    const a = adapter();
    const products = await a.fetchProducts();
    assert.deepStrictEqual(Object.keys(products), ['900001']);
  });

  test('a push that landed before the first poll wins over the stored copy', async () => {
    state.getAllProducts = async () => catalogue(['790420']);
    const a = adapter();
    await a.ingestPushed(FIXTURE, 'pokemon');           // the browser got there first
    const before = a._knownProducts.get('790420').price;

    const products = await a.fetchProducts();
    assert.strictEqual(products['790420'].price, before,
      'first-hand observation must not be overwritten by the stored row');
  });
});

describe('startup: hydration must never invent freshness', () => {
  test('a hydrated catalogue with no push still reports as not fresh', async () => {
    state.getAllProducts = async () => catalogue();
    const a = adapter();

    await a.fetchProducts();
    assert.deepStrictEqual(a._lastFreshness, { fresh: 0, attempted: 1 },
      'a full catalogue is not evidence the browser is running');
  });

  test('a failing Redis degrades to a cold start instead of throwing', async () => {
    state.getAllProducts = async () => { throw new Error('ECONNREFUSED'); };
    const a = adapter();

    const products = await a.fetchProducts();
    assert.deepStrictEqual(products, {}, 'no catalogue, but the poll still completes');
  });

  test('a failed hydrate is RETRIED, not written off for the life of the process', async () => {
    let calls = 0;
    state.getAllProducts = async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return catalogue();
    };
    const a = adapter();

    assert.deepStrictEqual(await a.fetchProducts(), {}, 'first attempt fails');
    a._hydrateRetryAt = 0;                       // the retry window has passed
    const products = await a.fetchProducts();

    assert.strictEqual(Object.keys(products).length, 20,
      'a Redis blip at boot must not leave the adapter cold forever — that is the flood again');
    assert.strictEqual(calls, 2);
  });

  test('the retry is throttled so it cannot time out on every poll', async () => {
    let calls = 0;
    state.getAllProducts = async () => { calls++; throw new Error('ECONNREFUSED'); };
    const a = adapter();

    await a.fetchProducts();
    await a.fetchProducts();
    await a.fetchProducts();
    assert.strictEqual(calls, 1, 'the retry window must suppress the next attempts');
  });

  test('a Redis that never answers is bounded, not waited on forever', async () => {
    state.getAllProducts = () => new Promise(() => {});   // never settles
    const a = adapter();

    const started = Date.now();
    const products = await a.fetchProducts();
    assert.deepStrictEqual(products, {});
    assert.ok(Date.now() - started < 8000, 'hydration must time out');
  });
});

describe('startup: unconfirmed rows do not become immortal', () => {
  test('a push confirms its SKUs first-hand and counts toward the grace', async () => {
    // 790420 and 804298 are the fixture's in-scope cards; its third (789777) is an Ultra Pro
    // binder that the scope rule rejects, so it is deliberately left out of the catalogue.
    state.getAllProducts = async () => catalogue(['790420', '804298', '900001']);
    const a = adapter();
    await a.fetchProducts();
    assert.strictEqual(a._unconfirmed.size, 3, 'hydrated rows start unconfirmed');

    await a.ingestPushed(FIXTURE, 'pokemon');
    assert.deepStrictEqual([...a._unconfirmed], ['900001'],
      'the SKUs the browser actually sent are confirmed');
    assert.strictEqual(a._pushesSinceHydrate, 1, 'the push counts toward the eviction grace');
  });

  test('a row the sweep never confirms is dropped once enough pushes have landed', async () => {
    state.getAllProducts = async () => catalogue();
    const a = adapter();
    await a.fetchProducts();

    // The browser sweeps 17 of the 20; three are genuinely gone from the site.
    await a.ingestPushed(pageOf(SKUS.slice(0, 17)), 'pokemon');
    a._pushesSinceHydrate = 200;                 // several sweeps' worth of pushes

    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 17,
      'a row swept past repeatedly is delisted, not held forever on a refreshing TTL');
  });

  test('ELAPSED TIME alone never evicts — a sleeping laptop is not a delisting', async () => {
    state.getAllProducts = async () => catalogue();
    const a = adapter();
    await a.fetchProducts();

    // The machine slept for hours, then the browser woke and landed exactly one page.
    await a.ingestPushed(pageOf(SKUS.slice(0, 17)), 'pokemon');
    a._startedAt = Date.now() - 6 * 60 * 60 * 1000;
    a._lastPushAt = Date.now();

    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 20,
      'the earlier clock-based grace evicted the whole unconfirmed catalogue on the first push '
      + 'after a sleep, which is precisely the flood this change exists to prevent');
  });

  test('a large unconfirmed share is a broken sweep, not a delisting, and evicts nothing', async () => {
    state.getAllProducts = async () => catalogue();
    const a = adapter();
    await a.fetchProducts();

    await a.ingestPushed(pageOf(SKUS.slice(0, 3)), 'pokemon');   // 17 of 20 still unconfirmed
    a._pushesSinceHydrate = 500;

    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 20,
      'evicting 85% of the catalogue at once would hand poll-adapter a mass delisting');
  });

  test('nothing is evicted before the grace is reached', async () => {
    state.getAllProducts = async () => catalogue();
    const a = adapter();
    await a.fetchProducts();

    await a.ingestPushed(pageOf(SKUS.slice(0, 17)), 'pokemon');
    const products = await a.fetchProducts();
    assert.strictEqual(Object.keys(products).length, 20,
      'evicting mid-sweep would recreate the exact bug hydration fixes');
  });
});
