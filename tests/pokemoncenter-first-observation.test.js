/**
 * The first REAL stock read of a Pokemon Center sku must not alert as a restock.
 *
 * WHY THIS IS A REAL BUG AND NOT A THEORETICAL ONE. _buildRow() defaults a sku with no cached
 * availability to `inStock: false`, so a product nobody has ever managed to read is stored
 * identically to one confirmed sold out. detectEvents fires RESTOCK on `!old.inStock &&
 * new.inStock`, and poll-adapter's seed gate only arms when stored state is COMPLETELY empty —
 * this store has ~800 rows, so it never arms. The first sweep that can actually see stock would
 * flip every available product false->true at once (~135 in trading-card-game alone) into the
 * client's PAID channel.
 *
 * The same defaulting already fired in the opposite direction in production: with Bright Data's
 * account suspended, 188 dead checks marked all 805 products out of stock while /api/health still
 * reported healthy.
 *
 * The last test here is the one that matters — it runs the real diff over a seeded row and the
 * row the very next poll builds, and asserts the pipeline produces NOTHING.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
const logger = require('../src/monitoring/logger');

// Stub before the adapter is constructed, exactly as tests/amazon-cold-start.test.js does: the
// adapter calls these exported functions, and leaving them real opens a Redis connection.
let redisStore;        // key -> value written through the pipeline
let seenMembers;       // contents of the stockseen set
let failMode;          // 'none' | 'noredis' | 'exec'

function fakeRedis() {
  if (failMode === 'noredis') return null;
  return {
    smembers: async () => [...seenMembers],
    pipeline() {
      const ops = [];
      return {
        set(key, value, ...rest) { ops.push(() => { redisStore[key] = value; }); return this; },
        sadd(key, ...members) { ops.push(() => { members.forEach((m) => seenMembers.add(m)); }); return this; },
        async exec() {
          if (failMode === 'exec') throw new Error('redis exec failed');
          ops.forEach((f) => f());
          return [];
        },
      };
    },
  };
}

state.getRedis = () => fakeRedis();

const PokemonCenter = require('../src/adapters/pokemoncenter');
const retailers = require('../src/config/retailers.json');
const list = Array.isArray(retailers) ? retailers : retailers.retailers;

const SEEN_KEY = 'tcg:pokemoncenter:stockseen';
const productKey = (sku) => `tcg:product:pokemoncenter:${sku}`;

/** Quiet the adapter's info logging so a run of these tests reads cleanly. */
function silence(fn) {
  const origInfo = logger.info;
  const origWarn = logger.warn;
  const lines = [];
  logger.info = (m) => lines.push(String(m));
  logger.warn = (m) => lines.push(String(m));
  return Promise.resolve().then(fn).then(
    (v) => { logger.info = origInfo; logger.warn = origWarn; return { value: v, lines }; },
    (e) => { logger.info = origInfo; logger.warn = origWarn; throw e; },
  );
}

let adapter;
beforeEach(() => {
  redisStore = {};
  seenMembers = new Set();
  failMode = 'none';
  adapter = new PokemonCenter(list.find((r) => r.id === 'pokemoncenter'));
});

/** Put a sku in the sitemap (so the poll would emit it) and optionally give it an observation. */
function known(sku, avail) {
  adapter.sitemapProducts.set(sku, {
    url: `https://www.pokemoncenter.com/en-ca/product/${sku}/thing`,
    name: `Product ${sku}`, english: true,
  });
  if (avail !== undefined) {
    adapter.availabilityCache.set(sku, { inStock: avail, price: 53.99, image: '', checkedAt: Date.now() });
  }
}

describe('first observation — what gets seeded', () => {
  test('an in-stock first reading is written to Redis and marked seen, not withheld', async () => {
    known('10-10320-101', true);
    const { value: withheld } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withheld.size, 0);
    assert.ok(redisStore[productKey('10-10320-101')], 'row should have been seeded');
    const row = JSON.parse(redisStore[productKey('10-10320-101')]);
    assert.strictEqual(row.inStock, true);
    assert.strictEqual(row.sku, '10-10320-101');
    assert.ok(seenMembers.has('10-10320-101'));
  });

  test('a sold-out first reading is seeded too, so a later restock is a real one', async () => {
    known('699-17157', false);
    await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(JSON.parse(redisStore[productKey('699-17157')]).inStock, false);
    assert.ok(seenMembers.has('699-17157'), 'must be marked seen or its first true reads as a restock');
  });

  test('a sku already marked seen is never re-seeded — that would swallow a real restock', async () => {
    seenMembers.add('10-10320-101');
    known('10-10320-101', true);
    await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(redisStore[productKey('10-10320-101')], undefined);
  });

  test('a sku seeded by a previous process is recognised after the set loads', async () => {
    seenMembers.add('10-10320-101');
    known('10-10320-101', true);
    known('10-99999-101', true);
    await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(redisStore[productKey('10-10320-101')], undefined, 'already seen');
    assert.ok(redisStore[productKey('10-99999-101')], 'genuinely new');
  });
});

describe('first observation — what is deliberately NOT seeded', () => {
  // Null is the parser refusing to answer. Marking it seen would burn the sku's one free pass on
  // a reading that never happened, and the real first observation would then alert.
  test('an unreadable sku is not seeded and not marked seen', async () => {
    known('10-10320-101', undefined);
    adapter.availabilityCache.set('10-10320-101', { inStock: null, price: null, image: '', checkedAt: Date.now() });
    await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(redisStore[productKey('10-10320-101')], undefined);
    assert.strictEqual(seenMembers.has('10-10320-101'), false);
  });

  test('a sku absent from the sitemap is skipped — the poll would not emit it either', async () => {
    adapter.availabilityCache.set('10-10320-101', { inStock: true, price: 1, image: '', checkedAt: Date.now() });
    await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(redisStore[productKey('10-10320-101')], undefined);
    assert.strictEqual(seenMembers.has('10-10320-101'), false);
  });

  test('nothing observed at all is a no-op that touches neither Redis nor the set', async () => {
    known('10-10320-101');    // in the sitemap, never read
    const { value: withheld } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withheld.size, 0);
    assert.deepStrictEqual(redisStore, {});
    assert.strictEqual(seenMembers.size, 0);
  });
});

describe('first observation — failure is handled in the safe direction', () => {
  // If the seed write fails, emitting the rows anyway is exactly the alert wave this prevents.
  // Withholding them costs one poll: the row is simply not diffed, and it already reads false.
  test('a failed pipeline withholds the rows and marks nothing seen', async () => {
    known('10-10320-101', true);
    known('10-99999-101', true);
    failMode = 'exec';

    const { value: withheld, lines } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withheld.size, 2);
    assert.ok(withheld.has('10-10320-101'));
    assert.strictEqual(seenMembers.size, 0, 'nothing may be marked seen if the write failed');
    assert.match(lines.join('\n'), /withholding 2 rows/);
  });

  test('no Redis connection is handled the same way, without throwing', async () => {
    known('10-10320-101', true);
    failMode = 'noredis';

    const { value: withheld } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 1);
    assert.strictEqual(seenMembers.size, 0);
  });

  test('a later poll retries after a failure and seeds successfully', async () => {
    known('10-10320-101', true);
    failMode = 'exec';
    await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(seenMembers.size, 0);

    failMode = 'none';
    const { value: withheld } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 0);
    assert.ok(seenMembers.has('10-10320-101'));
  });
});

describe('the poll path itself — fetchProducts, for real', () => {
  /**
   * tests/adapter-smoke.test.js stubs this seeding out, because it opens a Redis connection the
   * smoke test has no client for. So the wiring is proven HERE instead: a real fetchProducts()
   * against the stubbed Redis. Without this, a mistake in the call site would be caught by
   * nothing — which is the exact gap that let "batchSize is not defined" reach production.
   */
  function stubEdges(a) {
    a.scanSitemap = async () => {};
    a._loadAvailability = async () => {};
    a._loadUnfetchable = async () => {};
    a._saveAvailability = async () => {};
    a._saveUnfetchable = async () => {};
    a._selectCheckTargets = () => [];
  }

  test('a first observation is seeded and the row is still returned by the poll', async () => {
    stubEdges(adapter);
    known('10-10320-101', true);

    const { value: products } = await silence(() => adapter.fetchProducts());

    assert.strictEqual(products['10-10320-101'].inStock, true);
    assert.ok(redisStore[productKey('10-10320-101')], 'the row must have been seeded');
    assert.ok(seenMembers.has('10-10320-101'));
  });

  test('fetchProducts omits a sku whose seeding failed, and keeps the ones that were fine', async () => {
    stubEdges(adapter);
    known('10-10320-101', true);
    failMode = 'exec';

    const { value: products } = await silence(() => adapter.fetchProducts());

    assert.strictEqual(products['10-10320-101'], undefined, 'unseeded rows must not be emitted');
    assert.strictEqual(seenMembers.size, 0);
  });
});

describe('THE POINT — a seeded first observation produces no event', () => {
  const { diffProducts } = require('../src/core/events');

  test('the row the next poll builds diffs against the seeded row and raises nothing', async () => {
    known('10-10320-101', true);
    await silence(() => adapter._seedFirstObservations());

    const oldProducts = { '10-10320-101': JSON.parse(redisStore[productKey('10-10320-101')]) };
    const newProducts = {
      '10-10320-101': adapter._buildRow('10-10320-101',
        adapter.sitemapProducts.get('10-10320-101'), adapter.availabilityCache.get('10-10320-101')),
    };

    const events = diffProducts(oldProducts, newProducts);
    assert.deepStrictEqual(events, [], `expected no events, got ${JSON.stringify(events.map((e) => e.type))}`);
  });

  // The control: without seeding, this is precisely the false restock — and it proves the test
  // above is not passing for some unrelated reason.
  test('WITHOUT seeding, the same transition fires a RESTOCK (the bug being fixed)', () => {
    known('10-10320-101', true);
    const stored = adapter._buildRow('10-10320-101', adapter.sitemapProducts.get('10-10320-101'), undefined);
    assert.strictEqual(stored.inStock, false, 'an unobserved row is stored as out of stock');

    const fresh = adapter._buildRow('10-10320-101',
      adapter.sitemapProducts.get('10-10320-101'), adapter.availabilityCache.get('10-10320-101'));

    const events = diffProducts({ '10-10320-101': stored }, { '10-10320-101': fresh });
    assert.ok(events.some((e) => e.type === 'RESTOCK'), 'the unguarded path must fire the false restock');
  });

  test('a genuine restock AFTER the first observation still alerts', async () => {
    known('699-17157', false);
    await silence(() => adapter._seedFirstObservations());
    const seeded = JSON.parse(redisStore[productKey('699-17157')]);
    assert.strictEqual(seeded.inStock, false);

    // The product actually comes back in stock on a later poll.
    adapter.availabilityCache.set('699-17157', { inStock: true, price: 20.99, image: '', checkedAt: Date.now() });
    const { value: withheld } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 0);

    const fresh = adapter._buildRow('699-17157', adapter.sitemapProducts.get('699-17157'),
      adapter.availabilityCache.get('699-17157'));
    const events = diffProducts({ '699-17157': seeded }, { '699-17157': fresh });
    assert.ok(events.some((e) => e.type === 'RESTOCK'), 'a real restock must still fire');
  });
});
