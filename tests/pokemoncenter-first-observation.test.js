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
let storedRows;        // what state.getAllProducts() reports already being in Redis
let failMode;          // 'none' | 'noredis' | 'exec' | 'exec-reject'

function fakeRedis() {
  if (failMode === 'noredis') return null;
  return {
    smembers: async () => [...seenMembers],
    exists: async () => (seenMembers.size > 0 ? 1 : 0),
    sadd: async (key, ...members) => {
      if (failMode === 'exec') throw new Error('redis sadd failed');
      members.forEach((m) => seenMembers.add(m));
      return members.length;
    },
    get: async () => null,
    pipeline() {
      const ops = [];
      return {
        set(key, value, ...rest) { ops.push(() => { redisStore[key] = value; }); return this; },
        sadd(key, ...members) { ops.push(() => { members.forEach((m) => seenMembers.add(m)); }); return this; },
        /**
         * Real ioredis semantics, which the first version of this fake got wrong.
         *
         * A non-transactional pipeline RESOLVES with `[[err, result], ...]`; it rejects only on a
         * connection or cluster-slot error (Pipeline.js: fillResult captures each command error
         * into the results array). The old fake threw instead, so the production failure mode --
         * commands failing while exec resolves -- was unreachable in the tests and the code that
         * ignored the results array passed green.
         */
        async exec() {
          if (failMode === 'exec-reject') throw new Error('connection is closed');
          if (failMode === 'exec') {
            // Nothing is applied, and every command reports its own error, exactly as a Redis
            // OOM or a WRONGTYPE key would.
            return ops.map(() => [new Error('OOM command not allowed when used memory > maxmemory'), null]);
          }
          ops.forEach((f) => f());
          return ops.map(() => [null, 'OK']);
        },
      };
    },
  };
}

state.getRedis = () => fakeRedis();
state.getAllProducts = async () => storedRows;

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
  storedRows = {};
  failMode = 'none';
  adapter = new PokemonCenter(list.find((r) => r.id === 'pokemoncenter'));
});

/**
 * Put a sku in the sitemap (so the poll would emit it) and optionally give it an observation.
 *
 * It also gets a STORED row, because that is the situation this guard is for: ~800 products
 * already sitting in Redis at inStock:false, not because they are sold out but because nothing
 * could ever read them. Use `brandNew()` for a listing with no stored row at all.
 */
function known(sku, avail) {
  adapter.sitemapProducts.set(sku, {
    url: `https://www.pokemoncenter.com/en-ca/product/${sku}/thing`,
    name: `Product ${sku}`, english: true,
  });
  storedRows[sku] = { sku, name: `Product ${sku}`, price: null, inStock: false, retailerId: 'pokemoncenter' };
  if (avail !== undefined) {
    adapter.availabilityCache.set(sku, { inStock: avail, price: 53.99, image: '', checkedAt: Date.now() });
  }
}

/** A listing Redis has never stored — the case where NEW_SKU must survive. */
function brandNew(sku, avail) {
  known(sku, avail);
  delete storedRows[sku];
}

describe('first observation — what gets seeded', () => {
  test('an in-stock first reading is written to Redis and marked seen, not withheld', async () => {
    known('10-10320-101', true);
    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());

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
    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withheld.size, 0);
    assert.deepStrictEqual(redisStore, {});
    assert.strictEqual(seenMembers.size, 0);
  });
});

describe('a brand-new listing keeps its NEW_SKU', () => {
  /**
   * detectEvents emits NEW_SKU only when there is NO old product. Seeding writes a row before the
   * diff runs, so seeding a genuinely new listing makes oldProduct exist and the NEW_SKU never
   * fires -- and _registerWithEarlyScanner has already told the 12-hourly scanner to stay quiet
   * about that URL, on the assumption this adapter would announce it. The product would then be
   * announced by nothing at all, which for this store is the most valuable alert it can produce.
   *
   * The seed only exists to stop a false TRANSITION, and that needs something to transition from.
   */
  test('a sku with no stored row is NOT seeded, but IS marked seen', async () => {
    brandNew('10-99999-101', true);

    const { value: { withhold } } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withhold.size, 0);
    assert.strictEqual(redisStore[productKey('10-99999-101')], undefined,
      'seeding it would destroy the NEW_SKU');
    assert.ok(seenMembers.has('10-99999-101'),
      'still marked seen, or its next reading is treated as a first observation again');
  });

  test('and the diff therefore still produces NEW_SKU for it', async () => {
    const { diffProducts } = require('../src/core/events');
    brandNew('10-99999-101', true);
    await silence(() => adapter._seedFirstObservations());

    const fresh = adapter._buildRow('10-99999-101', adapter.sitemapProducts.get('10-99999-101'),
      adapter.availabilityCache.get('10-99999-101'));
    const events = diffProducts({}, { '10-99999-101': fresh });
    assert.ok(events.some((e) => e.type === 'NEW_SKU'), 'a brand-new listing must still announce');
  });

  test('a mix seeds only the ones that have a stored row', async () => {
    known('10-10320-101', true);        // already stored at inStock:false
    brandNew('10-99999-101', true);     // never stored

    const { value: { withhold }, lines } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withhold.size, 0);
    assert.ok(redisStore[productKey('10-10320-101')]);
    assert.strictEqual(redisStore[productKey('10-99999-101')], undefined);
    assert.deepStrictEqual([...seenMembers].sort(), ['10-10320-101', '10-99999-101']);
    assert.match(lines.join('\n'), /1 had no stored row and keep their NEW_SKU/);
  });
});

describe('first observation — failure is handled in the safe direction', () => {
  /**
   * THE DEFECT THIS PINS. A non-transactional ioredis pipeline RESOLVES when individual commands
   * fail -- errors arrive in the results array, and it rejects only on a connection or
   * cluster-slot error. The first version of this code awaited exec() and ignored the result, so
   * an OOM or a WRONGTYPE key would leave every row unwritten, mark every sku seen anyway, and
   * fire the whole restock wave on the next poll Redis accepted: the exact failure the function
   * exists to prevent, reached through its own success path.
   */
  test('commands failing while exec RESOLVES is treated as a failure, not a success', async () => {
    known('10-10320-101', true);
    known('10-99999-101', true);
    failMode = 'exec';

    const { value: { withhold }, lines } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(seenMembers.size, 0, 'nothing may be marked seen when the writes failed');
    assert.deepStrictEqual(redisStore, {}, 'and no row was written');
    assert.strictEqual(withhold.size, 2, 'the candidates are withheld instead of emitted');
    assert.match(lines.join('\n'), /commands failed/);
  });

  test('a rejecting exec (connection lost) is handled the same way', async () => {
    known('10-10320-101', true);
    failMode = 'exec-reject';

    const { value: { withhold } } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withhold.size, 1);
    assert.strictEqual(seenMembers.size, 0);
  });

  /**
   * Withholding is NOT free, which the first version's comment got wrong. A row missing from two
   * consecutive polls is written inStock:false by poll-adapter's stale path. So the withhold list
   * must be the candidates, never the whole catalogue -- over-withholding marks live products
   * dead and then fires that wave on recovery.
   */
  test('only the candidates are withheld, never the already-seen catalogue', async () => {
    seenMembers.add('old-1');
    seenMembers.add('old-2');
    known('old-1', true);
    known('old-2', true);
    known('10-10320-101', true);        // the only genuine candidate
    failMode = 'exec';

    const { value: { withhold } } = await silence(() => adapter._seedFirstObservations());

    assert.deepStrictEqual([...withhold], ['10-10320-101']);
  });
});

describe('first observation — the withhold is scoped to what could actually misfire', () => {
  test('a failed pipeline withholds the risky rows and marks nothing seen', async () => {
    known('10-10320-101', true);
    known('10-99999-101', true);
    failMode = 'exec';

    const { value: { withhold: withheld }, lines } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withheld.size, 2);
    assert.ok(withheld.has('10-10320-101'));
    assert.strictEqual(seenMembers.size, 0, 'nothing may be marked seen if the write failed');
    assert.match(lines.join('\n'), /withholding 2 row\(s\)/);
  });

  test('no Redis connection is handled the same way, without throwing', async () => {
    known('10-10320-101', true);
    failMode = 'noredis';

    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 1);
    assert.strictEqual(seenMembers.size, 0);
  });

  /**
   * The rule is "would emitting this look like a restock", not "is this a first observation".
   * A product already stored in stock cannot produce a RESTOCK, so starving it would be pure
   * harm: two missed polls and poll-adapter's stale path writes it out of stock, which then
   * fires the very wave on recovery.
   */
  test('a product already stored IN STOCK is never withheld', async () => {
    known('10-10320-101', true);
    storedRows['10-10320-101'].inStock = true;
    failMode = 'exec';

    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 0, 'no transition is possible, so nothing to protect against');
  });

  test('a reading of SOLD OUT is never withheld — it cannot fabricate a restock', async () => {
    known('699-17157', false);
    failMode = 'exec';

    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 0);
  });

  /**
   * The failure that made this rule necessary: on the first poll of a process the seen set has
   * not loaded, so if loading it is what fails, the candidate list is the WHOLE catalogue. The
   * old code withheld all of it — starving ~800 rows into poll-adapter's stale path.
   */
  test('a failure to load the seen set withholds only the risky rows, not the catalogue', async () => {
    for (let i = 0; i < 20; i += 1) {
      known(`in-stock-${i}`, true);
      storedRows[`in-stock-${i}`].inStock = true;      // steady state: already in stock
    }
    known('10-10320-101', true);                        // stored false, reads true: the risk
    adapter._loadStockSeen = async () => { throw new Error('WRONGTYPE'); };

    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());

    assert.deepStrictEqual([...withheld], ['10-10320-101']);
  });

  test('a later poll retries after a failure and seeds successfully', async () => {
    known('10-10320-101', true);
    failMode = 'exec';
    await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(seenMembers.size, 0);

    failMode = 'none';
    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());
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

describe('bootstrap — the cache restored at boot is already observed', () => {
  /**
   * availabilityCache only ever holds skus that produced a genuine reading, so everything in it
   * at boot has been observed and its stored row is already correct. Without this, the first run
   * would call all of them first observations, overwrite their rows before the diff, and swallow
   * any restock that happened to land in that one poll.
   */
  test('an empty set is established from whatever the cache restored', async () => {
    adapter.availabilityCache.set('10-10320-101', { inStock: true, price: 1, image: '', checkedAt: 1 });
    adapter.availabilityCache.set('699-17157', { inStock: false, price: 2, image: '', checkedAt: 1 });

    await silence(() => adapter._bootstrapStockSeen());

    assert.deepStrictEqual([...seenMembers].sort(), ['10-10320-101', '699-17157']);
    assert.strictEqual(adapter._stockSeenLoaded, true);
    assert.deepStrictEqual(redisStore, {}, 'bootstrap records, it does not rewrite product rows');
  });

  test('an unreadable cached entry is not counted as observed', async () => {
    adapter.availabilityCache.set('10-10320-101', { inStock: null, price: null, image: '', checkedAt: 1 });
    await silence(() => adapter._bootstrapStockSeen());
    assert.strictEqual(seenMembers.size, 0);
  });

  test('an existing set is authoritative and is left alone', async () => {
    seenMembers.add('old-sku');
    adapter.availabilityCache.set('10-10320-101', { inStock: true, price: 1, image: '', checkedAt: 1 });

    await silence(() => adapter._bootstrapStockSeen());

    assert.deepStrictEqual([...seenMembers], ['old-sku'], 'must not re-bootstrap over a live set');
    assert.strictEqual(adapter._stockSeenLoaded, false, 'so the real set still gets loaded');
  });

  test('an empty cache establishes nothing — there is nothing to vouch for', async () => {
    await silence(() => adapter._bootstrapStockSeen());
    assert.strictEqual(seenMembers.size, 0);
    assert.strictEqual(adapter._stockSeenLoaded, false);
  });

  test('a failure leaves the set unloaded so the next poll retries, and does not throw', async () => {
    adapter.availabilityCache.set('10-10320-101', { inStock: true, price: 1, image: '', checkedAt: 1 });
    failMode = 'exec';
    await assert.doesNotReject(silence(() => adapter._bootstrapStockSeen()));
    assert.strictEqual(adapter._stockSeenLoaded, false);
  });

  // The regression this whole block exists for.
  test('a restock in the FIRST poll after boot still alerts, instead of being overwritten', async () => {
    const { diffProducts } = require('../src/core/events');
    known('699-17157', false);                       // boot: last known reading was sold out
    await silence(() => adapter._bootstrapStockSeen());

    const stored = adapter._buildRow('699-17157', adapter.sitemapProducts.get('699-17157'),
      adapter.availabilityCache.get('699-17157'));

    // It comes back in stock during that very first poll.
    adapter.availabilityCache.set('699-17157', { inStock: true, price: 20.99, image: '', checkedAt: Date.now() });
    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());

    assert.strictEqual(withheld.size, 0);
    assert.strictEqual(redisStore[productKey('699-17157')], undefined,
      'the row must NOT have been overwritten — that is what swallows the restock');

    const fresh = adapter._buildRow('699-17157', adapter.sitemapProducts.get('699-17157'),
      adapter.availabilityCache.get('699-17157'));
    const events = diffProducts({ '699-17157': stored }, { '699-17157': fresh });
    assert.ok(events.some((e) => e.type === 'RESTOCK'), 'a real restock in the first poll must survive');
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
    const { value: { withhold: withheld } } = await silence(() => adapter._seedFirstObservations());
    assert.strictEqual(withheld.size, 0);

    const fresh = adapter._buildRow('699-17157', adapter.sitemapProducts.get('699-17157'),
      adapter.availabilityCache.get('699-17157'));
    const events = diffProducts({ '699-17157': seeded }, { '699-17157': fresh });
    assert.ok(events.some((e) => e.type === 'RESTOCK'), 'a real restock must still fire');
  });
});
