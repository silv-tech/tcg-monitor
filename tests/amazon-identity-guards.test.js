/**
 * A stock reading is only worth as much as the identity attached to it.
 *
 * Amazon repurposes ASINs. On 2026-09-09 an alert went to the client channel reading
 * "Pokémon TCG: Gardevoir ex League Battle Deck" whose link opened a Nex Playground games
 * console at $399.96 — the stored name, price and image were a frozen snapshot of a product
 * that no longer existed under that id. B0BCC6N8YL did the same on 2026-09-08, alerting as a
 * Pokemon booster while /dp/B0BCC6N8YL served a PopSockets phone grip.
 *
 * The sweep's AOD branch already guards this: it drops an ASIN whose live title is out of scope
 * and adopts a changed title. Two paths bypassed those guards while still adopting live stock,
 * and adopting stock is what fires an alert.
 *
 *   HOLE 1 — price-fill read AOD, took the price and could raise inStock, and never looked at
 *            data.name at all, despite the title sitting in the very response it had parsed.
 *
 *   HOLE 2 — both guards are written `if (data.name && ...)`, and _parseAod returns name:null
 *            whenever the title regex misses but an offer parses. A titleless read therefore
 *            skipped BOTH checks and still adopted inStock — the one transition that alerts.
 *
 * The withholding is deliberately one-directional. A titleless read may still take a product out
 * of stock, still update price and image. Only "this is now buyable" waits for a confirmed name,
 * because only that one can put a wrong product in front of a customer.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
// The adapter reaches for Redis on hydration (catalogue + identity denylist); an open
// connection keeps this test process alive after every assertion has passed.
state.getRedis = () => null;
// state.js calls its OWN internal getRedis(), so stubbing the exported getRedis does not stop
// a real connection opening — the exported functions the adapter calls must be stubbed instead.
state.getDeniedIdentities = async () => new Map();
state.denyIdentity = async () => {};
const AmazonAdapter = require('../src/adapters/amazon');

state.getAllProducts = async () => ({});

const CFG = {
  id: 'amazon', name: 'Amazon Canada', url: 'https://www.amazon.ca',
  adapter: 'amazon', intervalMs: 6000, proxyTier: 'isp', enabled: true, watchlist: [],
};

const GARDEVOIR = 'Pokémon TCG: Gardevoir ex League Battle Deck';
const NEX = 'Nex Playground - Active Play Video Game Console for Kids';

function adapter(aodByAsin) {
  const a = new AmazonAdapter(CFG);
  a._hydrated = true;                                  // hydration is covered elsewhere
  a._stealthCheckAsin = async (asin) => aodByAsin[asin] ?? null;
  return a;
}

const cached = (over = {}) => ({
  sku: 'B0D2JGYX3F', name: GARDEVOIR, price: 81.87, inStock: false, canAddToCart: false,
  category: 'pokemon', retailerId: 'amazon', image: 'https://img/old.jpg', ...over,
});

describe('HOLE 1 — the price-fill path now checks what it is filling', () => {
  /**
   * Drives the REAL _runDiscovery price-fill loop: a search tile with no usable price queues
   * the ASIN for an AOD lookup, and that lookup is what used to adopt price and stock blind.
   */
  async function discoverWith(tile, aod) {
    const a = adapter(aod);
    a._freeSearch = async () => [tile];
    a.searchQueries = ['pokemon tcg'];
    a._lastFetchThrottled = false;
    const products = {};
    await a._runDiscovery(products);
    return { a, products };
  }

  // A tile that shows the product but no price — exactly what queues a price-fill.
  const pricelessTile = {
    asin: 'B0D2JGYX3F', name: GARDEVOIR, price: null, inStock: true, url: 'https://www.amazon.ca/dp/B0D2JGYX3F',
    image: 'https://img/old.jpg', _priceUnknown: true,
  };

  test('a repurposed ASIN is DROPPED rather than price-filled under the stale name', async () => {
    const { a, products } = await discoverWith(pricelessTile,
      { B0D2JGYX3F: { name: NEX, price: 399.96, inStock: true } });

    assert.ok(!('B0D2JGYX3F' in products),
      'a Nex Playground console must not be published as a Pokemon deck');
    assert.ok(!a._knownProducts.has('B0D2JGYX3F'),
      'and it must not survive in the catalogue to alert on a later poll');
  });

  test('a genuine product is still price-filled and published', async () => {
    const { a, products } = await discoverWith(pricelessTile,
      { B0D2JGYX3F: { name: GARDEVOIR, price: 81.87, inStock: true } });

    const p = products.B0D2JGYX3F;
    assert.ok(p, 'the guard must not cost us a real fill');
    assert.strictEqual(p.price, 81.87);
    assert.strictEqual(p.inStock, true);
    assert.ok(a._knownProducts.has('B0D2JGYX3F'));
  });

  test('a relisted-but-still-in-scope title is adopted, not filled under the old name', async () => {
    const NEWNAME = 'Pokémon TCG: Charizard ex Premium Collection';
    const { products } = await discoverWith(pricelessTile,
      { B0D2JGYX3F: { name: NEWNAME, price: 59.99, inStock: true } });

    const p = products.B0D2JGYX3F;
    assert.ok(p, 'still a Pokemon product, so it stays');
    assert.strictEqual(p.name, NEWNAME, 'the live title wins over the stale stored one');
  });

  test('a failed AOD read leaves the tile exactly as it was — no drop, no invention', async () => {
    const { a, products } = await discoverWith(pricelessTile, {});   // _stealthCheckAsin -> null
    assert.ok('B0D2JGYX3F' in products || a._knownProducts.has('B0D2JGYX3F'),
      'a blocked lookup must never be read as "this product is not what we thought"');
  });

  test('a titleless AOD read still fills the price without dropping the row', async () => {
    const { products } = await discoverWith(pricelessTile,
      { B0D2JGYX3F: { name: null, price: 81.87, inStock: true } });
    const p = products.B0D2JGYX3F;
    assert.ok(p, 'no title is not evidence the product changed');
    assert.strictEqual(p.price, 81.87);
  });
});

describe('HOLE 2 — a titleless read cannot announce a restock', () => {
  let a;
  let products;
  beforeEach(() => {
    products = {};
    a = adapter({});
  });

  /** The exact expression the sweep now uses. */
  const raisesBlind = (data, prev) => Boolean(data.inStock && !prev?.inStock && !data.name);

  test('in stock, no title, previously out of stock -> withheld', () => {
    assert.strictEqual(raisesBlind({ inStock: true, name: null }, cached({ inStock: false })), true);
  });

  test('in stock WITH a title -> published normally', () => {
    assert.strictEqual(raisesBlind({ inStock: true, name: GARDEVOIR }, cached({ inStock: false })), false,
      'a confirmed identity must never be delayed');
  });

  test('already in stock, no title -> nothing withheld, there is no transition to fire', () => {
    assert.strictEqual(raisesBlind({ inStock: true, name: null }, cached({ inStock: true })), false);
  });

  test('going OUT of stock with no title is still applied', () => {
    assert.strictEqual(raisesBlind({ inStock: false, name: null }, cached({ inStock: true })), false,
      'withholding an out-of-stock read would leave a sold-out product advertised as buyable');
  });

  test('the guard is one-directional in the source', () => {
    const src = require('fs').readFileSync(require.resolve('../src/adapters/amazon.js'), 'utf8');
    assert.match(src, /raisesStockBlind\s*=\s*data\.inStock\s*&&\s*!cached\?\.inStock\s*&&\s*!data\.name/,
      'the condition must require ALL THREE: now in stock, previously not, and no title');
    assert.match(src, /inStock: raisesStockBlind \? cached\.inStock : data\.inStock/);
    assert.match(src, /canAddToCart: raisesStockBlind \? cached\.canAddToCart : data\.inStock/);
  });

  test('a withheld restock is stamped hot, so it is re-checked in ~30s not ~5min', () => {
    const src = require('fs').readFileSync(require.resolve('../src/adapters/amazon.js'), 'utf8');
    assert.match(src, /if \(product\.inStock \|\| raisesStockBlind\) this\._lastInStockAt\.set\(asin, Date\.now\(\)\)/,
      'without this the guard would cost a genuine restock a full sweep of latency');
  });

  test('it is logged, never silent', () => {
    const src = require('fs').readFileSync(require.resolve('../src/adapters/amazon.js'), 'utf8');
    assert.match(src, /read in stock with NO title/,
      'a withheld restock must be visible — a silent hold is indistinguishable from a miss');
  });
});

describe('the scope authority actually rejects the product that caused this', () => {
  const { isInScopeName } = require('../src/utils/scope');

  test('the Nex Playground title is out of scope', () => {
    assert.strictEqual(isInScopeName(NEX), false);
    assert.strictEqual(isInScopeName('Nex Playground'), false);
  });

  test('the Pokemon title it displaced is in scope', () => {
    assert.strictEqual(isInScopeName(GARDEVOIR), true);
  });

  test('the 2026-09-08 case is rejected too', () => {
    assert.strictEqual(isInScopeName('PopSockets PopGrip Phone Grip and Stand'), false);
  });
});

describe('HOLE 2, driven through the real sweep', () => {
  /**
   * Executes `_monitorKnownAsinsInner` for one cached ASIN with a stubbed AOD reply, and returns
   * what the sweep published. Source-text assertions cannot catch a semantic inversion; this can.
   */
  async function sweepWith(cachedRow, aodReply) {
    const a = adapter({ [cachedRow.sku]: aodReply });
    a._hydrated = true;
    a._aodCooldownUntil = 0;
    a.getFastPollAsins = () => new Set();          // force the cold sweep to take this ASIN
    a._knownProducts.set(cachedRow.sku, cachedRow);
    const products = {};
    await a._monitorKnownAsinsInner(products);
    return { published: products[cachedRow.sku], adapter: a };
  }

  test('in stock with NO title does not publish the restock', async () => {
    const { published } = await sweepWith(cached({ inStock: false, canAddToCart: false }),
      { name: null, price: 81.87, inStock: true });
    assert.ok(published, 'the row must still be published — only the stock RAISE is withheld');
    assert.strictEqual(published.inStock, false,
      'a titleless read must not announce "buyable now" under a name nobody confirmed');
    assert.strictEqual(published.canAddToCart, false);
  });

  test('in stock WITH a title publishes the restock normally', async () => {
    const { published } = await sweepWith(cached({ inStock: false, canAddToCart: false }),
      { name: GARDEVOIR, price: 81.87, inStock: true });
    assert.strictEqual(published.inStock, true, 'a confirmed identity must never be delayed');
    assert.strictEqual(published.canAddToCart, true);
  });

  test('a titleless read still takes a product OUT of stock', async () => {
    const { published } = await sweepWith(cached({ inStock: true, canAddToCart: true }),
      { name: null, price: 81.87, inStock: false });
    assert.strictEqual(published.inStock, false,
      'withholding this direction would advertise a sold-out product as buyable');
  });

  test('a titleless read still updates the price', async () => {
    const { published } = await sweepWith(cached({ inStock: false, price: 81.87 }),
      { name: null, price: 59.99, inStock: true });
    assert.strictEqual(published.price, 59.99, 'only the stock raise is withheld, not everything');
  });

  test('an out-of-scope live title drops the ASIN entirely', async () => {
    const { published, adapter: a } = await sweepWith(cached({ inStock: false }),
      { name: NEX, price: 399.96, inStock: true });
    assert.strictEqual(published, undefined, 'a Nex Playground console must not be published');
    assert.ok(!a._knownProducts.has('B0D2JGYX3F'), 'and it must not survive to alert later');
  });

  test('a withheld restock is stamped hot so it is re-checked quickly', async () => {
    const { adapter: a } = await sweepWith(cached({ inStock: false, canAddToCart: false }),
      { name: null, price: 81.87, inStock: true });
    assert.ok(a._lastInStockAt.has('B0D2JGYX3F'),
      'without the stamp the withheld restock waits a full cold sweep instead of the fast lane');
  });
});
