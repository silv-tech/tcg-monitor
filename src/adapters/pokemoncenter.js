const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, sleep, hashSku } = require('../utils/helpers');
const { FAILURE_REASONS, classifyError } = require('../core/failure-reasons');
const { stealthGet } = require('../utils/stealth-http');
const { getProxyUrl } = require('../core/proxy');
const state = require('../core/state');
const brightData = require('../utils/brightdata');
const { isInScopeName } = require('../utils/scope');

// How long a catalogue may go with no successful stock read before health calls it down.
// Covers BOTH failure modes: every check failing, and no check being attempted at all
// (budget spent, everything parked). Measured 2026-09-11, the store sat in the second
// state reporting healthy:true. Generous, because a slow rotation can legitimately be
// quiet for hours; a browser bridge makes it minutes.
const STOCK_BLIND_MS = Number(process.env.PC_STOCK_BLIND_MS) || 6 * 60 * 60 * 1000;

// One Redis key for the whole availability cache — written at most once per poll.
const PC_AVAILABILITY_KEY = 'tcg:pokemoncenter:availability';
const PC_UNFETCHABLE_KEY = 'tcg:pokemoncenter:unfetchable';

// Every sku whose stock has ever been GENUINELY read. See _seedFirstObservations().
//
// No TTL. The product keys it guards expire after 7 days, but this set must outlive them: if it
// aged out, every sku would look unobserved again and the next poll would re-seed rows that are
// already correct, swallowing a real restock. Membership is ~800 short strings.
const PC_STOCK_SEEN_KEY = 'tcg:pokemoncenter:stockseen';

// Some Pokemon Center pages cannot be fetched at all. Verified directly: three SKUs failed
// six times out of six from two different networks, each returning HTTP 200 with a ZERO-byte
// body after 55-106 seconds. Not a timeout of ours and not a block — Bright Data simply
// cannot render those particular pages.
//
// Left alone, the rotation retries them forever at roughly 160s a product, which starves the
// products that DO work: at ~400 checks a day, every slot spent on an unfetchable page is a
// fetchable one that never gets looked at. After this many consecutive failures a SKU is
// parked, and re-tried once the cooldown expires in case the vendor improves.
const UNFETCHABLE_AFTER = 2;
const UNFETCHABLE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// The parent TCG category. Its listing pages carry ~32 products each and support a real
// server-side in-stock filter, so the whole in-stock set is five requests rather than 1,195.
// Headed-browser category sweep. A category ends when a page returns zero tiles (page 20 of
// trading-card-game is empty while page 8 has 34), so this ceiling is a runaway guard rather
// than an expected value.
const PC_SWEEP_MAX_PAGES = 40;
// The grid is client-rendered after hydration -- at 6s the content area is still empty and only
// the mega-menu has /en-ca/product/ links, which is what made an earlier parser report
// navigation entries as products.
const PC_RENDER_WAIT_MS = 8000;
const PC_PAGE_TIMEOUT_MS = 60000;
// Browsing pace, not burst pace. This is a store the client buys from.
const PC_PAGE_SPACING_MS = 4000;
// Products per page, via the `ps` query parameter.
//
// The store's own "Items per page" control offers 32, 64 and 96, and 96 is what it puts in the
// URL. Probe 5 (2026-09-16) asked for it on a plain navigation and got 95 products back in one
// load, against the default 32.
//
// This is the only lever that touches the rate limit. Reading the products out of __NEXT_DATA__
// instead of the rendered tiles saves NO requests -- it is the same page load -- and page loads
// are the only thing this site counts. The measured sweep needed 5 pages to cover 129 products;
// at 96 that is 2, so the same coverage costs a third of the requests and a third of the spacing
// waits. Overridable because the tolerable cadence is still unmeasured and this is the first
// number anyone will want to turn down.
// Resolved, not `Number(x) || 96`: that idiom turns the documented escape hatch PC_PAGE_SIZE=0
// straight back into 96, because 0 is falsy. The one input intended to restore the store's own
// default was the one input that could not work, and a test asserting the 0 behaviour passed
// anyway because it called the builder directly. It also let `96.5` through into the URL.
function resolvePageSize(raw, fallback = 96) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
const PC_PAGE_SIZE = resolvePageSize(process.env.PC_PAGE_SIZE);
// A persistent profile so the Imperva session looks like a returning visitor rather than a new
// one on every page.
const PC_BROWSER_PROFILE = '/tmp/pc-sweep-profile';

/**
 * Runs INSIDE the page. Returns one row per distinct SKU: { sku, name, price, inStock }.
 *
 * A tile is located by walking up from a product anchor to the nearest ancestor whose text
 * contains a price. That is the only reliable boundary here: the mega-menu carries its own
 * /en-ca/product/ links (66 anchors on a page with ~31 products), and each product renders
 * twice -- once for the image, once for the title -- so results are deduped by SKU.
 *
 * inStock is TRUE only on a positive price with no SOLD OUT, FALSE only on an explicit SOLD OUT,
 * and NULL otherwise. Null is dropped by the caller: an unreadable tile must never become a
 * stock transition.
 */
function pcExtractTiles() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/en-ca/product/"]')) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/product\/([^/]+)\/([^/?#]*)/);
    if (!m || seen.has(m[1])) continue;
    let el = a;
    let hops = 0;
    while (el && hops < 6 && !/\$\s*\d+\.\d{2}/.test(el.innerText || '')) {
      el = el.parentElement; hops += 1;
    }
    if (!el) continue;                       // no priced ancestor: a menu link, not a tile
    seen.add(m[1]);
    // RAW text only. The stock verdict is deliberately NOT decided here: this function is
    // serialised into the page by page.evaluate(), so it cannot call module scope and nothing in
    // it can be unit-tested. Keeping the rule out of here means there is exactly one copy of it,
    // in pcVerdict() below, and that copy is testable. A rule that lives only in an untestable
    // place is how the Amazon seller gate silently stopped working.
    out.push({
      sku: m[1],
      slug: m[2] || '',
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }
  return out;
}

// The stock verdict and its safety rule live in a dependency-free module so the grid probe can
// share the one copy without loading src/config. See pokemoncenter-verdict.js.
const { pcVerdict, pcNameFromSlug } = require('./pokemoncenter-verdict');
const { pcProductsFromNextData } = require('./pokemoncenter-nextdata');

const CATEGORY_URL = 'https://www.pokemoncenter.com/en-ca/category/trading-card-game';
// 137 in stock at 32 a page is five; the ceiling is a runaway guard, not an expected value.
const CATEGORY_MAX_PAGES = 12;
// Pages are independent, so they overlap; the cap keeps a sweep from looking like a burst.
const CATEGORY_CONCURRENCY = 3;
const CATEGORY_PAGE_ATTEMPTS = 2;

/**
 * Read stock and price out of a schema.org `offers`, whichever shape it arrives in.
 *
 * Pokemon Center uses two, and until the catalogue was widened beyond TCG we only ever met one:
 *
 *   Offer           a single product      { "@type":"Offer", availability, price }
 *   AggregateOffer  anything with SIZES   { "@type":"AggregateOffer", lowPrice, highPrice,
 *                                           offerCount, offers:[ {sku, availability, price} ] }
 *
 * Measured 2026-09-11: the TCG zip binder 10-10320-101 is the first shape; the Crocs clog
 * 70-11607 is the second, with nine size variants of which four were InStock and three were not.
 * The old reader looked only for `offers.availability`, which an AggregateOffer does not have —
 * so every clothing and footwear product in the store read as out of stock with no price, and
 * the browser bridge reported "20 read nothing, http200 no-ld 447kb" on twenty perfectly good
 * pages. That is 7,610 of the 8,415 products.
 *
 * A sized product is IN STOCK if any size is. That is the honest answer for a stock monitor:
 * somebody can buy it. Price comes from lowPrice, which is what the shopper sees first.
 */
function readOffers(offers) {
  const none = { inStock: false, price: null };
  if (!offers) return none;

  const list = Array.isArray(offers) ? offers : [offers];
  let inStock = false;
  let price = null;

  for (const o of list) {
    if (!o || typeof o !== 'object') continue;

    if (Array.isArray(o.offers) && o.offers.length > 0) {          // AggregateOffer
      for (const v of o.offers) {
        if (v && String(v.availability || '').includes('InStock')) { inStock = true; break; }
      }
      const low = Number(o.lowPrice);
      if (Number.isFinite(low) && low > 0) price = price == null ? low : Math.min(price, low);
      continue;
    }

    if (String(o.availability || '').includes('InStock')) inStock = true;   // plain Offer
    const p = typeof o.price === 'number' ? o.price : normalizePrice(String(o.price || ''));
    if (Number.isFinite(p) && p > 0) price = price == null ? p : Math.min(price, p);
  }

  return { inStock, price };
}

/**
 * A category page URL, built for a full navigation.
 *
 * Page 1 carries no `page` parameter, matching what the site itself produces and keeping the
 * URL identical to the one a shopper lands on. `ps` is omitted entirely when zero, so setting
 * PC_PAGE_SIZE=0 falls back to the store's default rather than sending `ps=0`.
 */
function pcCategoryUrl(base, page, pageSize) {
  const qs = [];
  if (page > 1) qs.push(`page=${page}`);
  if (pageSize > 0) qs.push(`ps=${pageSize}`);
  return qs.length ? `${base}?${qs.join('&')}` : base;
}

class PokemonCenterAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.sitemapUrl = 'https://www.pokemoncenter.com/sitemaps/products.xml';
    this.domain = 'www.pokemoncenter.com';
    this.seedUrl = 'https://www.pokemoncenter.com/en-ca/';

    // A cheap slug prefilter ONLY. This is not the scope rule: it admits card sleeves,
    // playmats, zip binders, deck boxes, bag tags and backpacks, because every one of those
    // carries '-tcg-' in its slug. The authoritative gate is isInScopeName() from utils/scope,
    // the same rule the other 17 stores use. Pokemon Center was the last store still deciding
    // scope on its own, and it was tracking 413 accessories the client explicitly excluded —
    // every product it had marked in stock was one of them.
    this.tcgKeywords = [
      'pokemon-tcg-', '-tcg-',
      'booster-box', 'booster-bundle', 'elite-trainer-box',
      'collection-box', 'special-collection', 'premium-collection',
      'build-and-battle', 'league-battle-deck', 'ultra-premium',
      'poster-collection', 'tech-sticker-collection',
      'combined-powers', 'super-premium',
      'scarlet-violet', 'prismatic-evolutions',
      'surging-sparks', 'stellar-crown', 'twilight-masquerade',
      'shrouded-fable', 'paldean-fates', 'paradox-rift',
      'temporal-forces', 'obsidian-flames', 'paldea-evolved',
      'astral-radiance', 'brilliant-stars', 'lost-origin',
      'silver-tempest', 'crown-zenith',
    ];

    // Product cache from sitemap — persists across polls
    this.sitemapProducts = new Map(); // sku -> { url, name }
    this.availabilityCache = new Map(); // sku -> { inStock, price, image, checkedAt }
    this.lastSitemapScan = 0;
    // The sitemap is the ONE thing on this site DataDome does not guard — it answers a plain
    // stealth GET, and it honours If-None-Match with a 304 in ~500ms and zero bytes. So the
    // new-listing check costs nothing and can run on the poll cadence; the 24.6MB body is only
    // pulled when Pokemon Center actually republishes. At the old 4-hour timer a new product
    // could sit unseen for four hours even though spotting it was free.
    this._sitemapValidators = null;

    // Availability sits behind two bot walls: DataDome answers every HTTP client with 403
    // (any TLS fingerprint, any IP) and Incapsula serves headless Chromium a block iframe.
    // ScraperAPI ultra_premium is the only path through, at 25 credits a call — so sweeping
    // 1,195 products is impossible. Paid checks are spent only where they buy something:
    // products that just appeared in the sitemap, and explicitly watchlisted SKUs.
    this._deriveTiming();
    this.watchlist = new Set(config.watchlist || []);

    this._knownSkus = new Set();      // every sku seen in a sitemap scan
    this._newSkuQueue = [];             // newly listed skus awaiting a paid check
    this._rotationCheckedAt = new Map(); // sku -> last rotation check, so the sweep is fair
    this._rotationSpentToday = 0;
    this._rotationDay = null;
    this._seededSkus = false;         // first scan seeds silently — no flood after a restart
    this._stockSeen = new Set();      // skus whose stock has ever been read — see _seedFirstObservations
    this._stockSeenLoaded = false;
    this._watchlistCheckedAt = new Map();
    this._stealthBlockedUntil = 0;    // free-path circuit; retried occasionally in case the block lifts
    this._lastPaidCheckAt = 0;        // wall-clock gate on ScraperAPI spend (see _deriveTiming)

    // Track consecutive full-poll failures to avoid noisy error logging
    this._consecutiveFailures = 0;
    this._failStreak = new Map();     // sku -> consecutive total failures
    this._unfetchable = new Map();    // sku -> { until } while parked
    this._freshAttempts = 0;          // stock reads attempted since the last freshness report
    this._freshSuccesses = 0;         // ...and how many produced data. Health reads these.
    // Seeded to process start so a fresh boot is given STOCK_BLIND_MS to read something before
    // it is called blind; _loadAvailability advances it to the newest stored checkedAt.
    this._lastGoodReadAt = Date.now();
    this._blindWarned = false;
    this._sweepDisabledLogged = false;

    // SKUs the last COMPLETE category sweep reported in stock. Only these can be cleared by a
    // later sweep, which keeps the absent-means-out-of-stock inference to products the sweep
    // is actually authoritative for.
    this._categoryInStock = new Set();
    this._lastCategorySweepAt = 0;
    this._categorySweepRunning = false;
  }

  _deriveTiming() {
    this.checksPerPoll = this.timingValue('checksPerPoll', 3, 1);
    this.watchlistIntervalMs = this.timingValue('watchlistIntervalMs', 30 * 60 * 1000, 5 * 60 * 1000);
    this.sitemapIntervalMs = this.timingValue('sitemapIntervalMs', 8 * 1000, 5 * 1000);
    // Paid availability checks are gated on WALL CLOCK, never on poll count. The free sitemap
    // check now runs every ~8s; if the paid checks rode the same cadence, checksPerPoll=3 would
    // mean ~32,000 ScraperAPI calls a day at 25 credits each. This is the only thing standing
    // between a fast poll loop and the entire monthly budget.
    this.paidCheckIntervalMs = this.timingValue('paidCheckIntervalMs', 5 * 60 * 1000, 60 * 1000);
    // The category sweep costs ~5 requests and refreshes the WHOLE in-stock set, so it is the
    // cheapest coverage available here — but it is still billed per request, hence a wall-clock
    // gate of its own rather than riding the ~8s poll loop.
    this.categorySweepIntervalMs = this.timingValue('categorySweepIntervalMs', 5 * 60 * 1000, 60 * 1000);
  }

  /**
   * Products the paid checker should spend credits on this poll.
   *
   * This used to draw from exactly two sources — the watchlist and newly-seen SKUs — and with
   * an empty watchlist and a stable sitemap it selected NOTHING, on every poll, indefinitely.
   * The store logged "1195 products, no checks due (0 queued, 0 with known stock)" for days:
   * no product ever got a price, none was ever marked in stock, and so no restock could ever
   * be detected. A big-six retailer that structurally could not alert.
   *
   * A third source fixes the deadlock: rotate through the catalogue, oldest-checked first.
   * It is strictly budget-bounded because these checks are expensive — DataDome 403s the free
   * path (verified against live product pages), so every check is a 25-credit ultraPremium
   * ScraperAPI call. At 1,195 products a full rotation is 29,875 credits, roughly a third of
   * the monthly plan, which is why rotation alone can never be the answer.
   *
   * Priority order matters more than volume here:
   *   1. watchlist    — the products someone explicitly cares about
   *   2. new SKUs     — a listing that just appeared
   *   3. rotation     — everything else, oldest first, so nothing is permanently invisible
   */
  /**
   * The availability cache is the ONLY record of what anything costs or whether it is in
   * stock — the sitemap gives names and URLs and nothing else. It lived in memory, so every
   * deploy wiped it: observed directly, the priced count fell from 17 back to 3 across one
   * restart. At ~400 paid checks a day against 1,195 products, a catalogue that resets on
   * each deploy can never accumulate coverage, which is why this store looked permanently
   * blind no matter how well the fetching worked.
   *
   * Kept in Redis under one key rather than per-product: it is written once per poll at most,
   * and a single blob avoids 1,195 round trips.
   */
  /**
   * Run paid availability checks outside the poll.
   *
   * Free to be slow and to retry, because nothing is waiting on it. Every observed Bright
   * Data failure was an empty body after 59-99s, and those succeed on a second attempt —
   * the retry that could never fit inside a poll fits trivially here.
   */
  async _runChecks(targets) {
    let checked = 0;
    const failureCounts = {};
    // Belt and braces: even if the batch size is ever mis-sized again, a batch cannot run
    // indefinitely and strand the _checkRunning guard.
    const batchDeadline = Date.now() + (Number(process.env.PC_BATCH_MAX_MS) || 10 * 60 * 1000);
    for (const sku of targets) {
      if (Date.now() >= batchDeadline) {
        logger.info(`Pokemon Center: batch deadline reached after ${checked}/${targets.length} — rest deferred`);
        break;
      }
      const meta = this.sitemapProducts.get(sku);
      if (!meta) continue;
      if (this.watchlist.has(sku)) this._watchlistCheckedAt.set(sku, Date.now());
      try {
        const { data, failReason } = await this.checkProductAvailability(sku, meta);
        if (data) {
          data.checkedAt = Date.now();
          this.availabilityCache.set(sku, data);
          this._noteCheckOutcome(sku, true);
          checked++;
        } else if (failReason) {
          failureCounts[failReason] = (failureCounts[failReason] || 0) + 1;
          this._noteCheckOutcome(sku, false);
        }
      } catch (err) {
        const reason = classifyError(err);
        failureCounts[reason] = (failureCounts[reason] || 0) + 1;
        this._noteCheckOutcome(sku, false);
      }
      await sleep(500 + Math.floor(Math.random() * 1000));
    }
    if (checked > 0) await this._saveAvailability();
    await this._saveUnfetchable();
    const failSummary = Object.entries(failureCounts).map(([k, v]) => `${k}=${v}`).join(' ');
    logger.info(`Pokemon Center: background checks — ${checked}/${targets.length} succeeded` +
      `${failSummary ? ` (${failSummary})` : ''}, ${this.availabilityCache.size} products with known stock`);
  }

  /** A SKU parked after repeated total failures, so the rotation stops paying for it. */
  _isUnfetchable(sku, now = Date.now()) {
    const entry = this._unfetchable.get(sku);
    if (!entry) return false;
    if (now >= entry.until) { this._unfetchable.delete(sku); return false; }
    return true;
  }

  /** Park immediately, for causes already known to be permanent for this URL. */
  _parkNow(sku, reason) {
    if (this._unfetchable.has(sku)) return;
    this._unfetchable.set(sku, { until: Date.now() + UNFETCHABLE_COOLDOWN_MS, reason });
    logger.info(`Pokemon Center: parking ${sku} for ${UNFETCHABLE_COOLDOWN_MS / 3600000}h — ${reason}`);
  }

  /** The one place a Pokemon Center product row is shaped. */
  /**
   * Stop the first REAL stock read of a sku from being alerted as a restock.
   *
   * THE BUG THIS EXISTS FOR. _buildRow() defaults a sku with no cached availability to
   * `inStock: false`, so a product nobody has ever managed to read is stored identically to one
   * confirmed sold out. Nothing downstream can tell them apart: detectEvents fires RESTOCK on
   * `!old.inStock && new.inStock` (core/events.js), and the poller's own seed gate only arms when
   * stored state is COMPLETELY empty (core/poll-adapter.js) — this store has ~800 rows, so it
   * never arms. The day stock becomes readable, every available product flips false->true in one
   * poll: ~135 in trading-card-game alone, straight into the client's paid channel. Those are
   * first observations, not restocks.
   *
   * The same defaulting has already fired once in the opposite direction. With Bright Data's
   * account suspended, 188 dead checks marked all 805 products out of stock while /api/health
   * still reported healthy — a totally blind store was indistinguishable from a fully sold-out one.
   *
   * WHAT THIS DOES. Before the poll returns its rows — and therefore before poll-adapter reads
   * the old state to diff against — any sku being observed for the first time has its row written
   * to Redis exactly as the poller would write it. The diff then compares that row against itself
   * and raises nothing. The sku is recorded in PC_STOCK_SEEN_KEY, so the NEXT change to it is a
   * genuine transition and alerts normally.
   *
   * WHY THIS AND NOT A CHANGE TO detectEvents. The restock rule is shared by 37 retailers, and
   * the knowledge that a stored `false` was never an observation exists only in this adapter.
   * Pre-writing state is also the established precedent here — EB Games' _seedRedis does the same
   * thing for its catalogue.
   *
   * THE ONE LANE THIS DOES NOT COVER. The watchlist fast-poll (core/scheduler.js) never calls
   * fetchProducts: it reads adapter.fetchProductPage() and diffs against state.getProduct()
   * directly. This adapter does not implement fetchProductPage, so that lane cannot run for this
   * store today — but it has a 57-sku watchlist configured and is the lane with the FEWEST brakes
   * in the system (limiter-exempt, 45s dedup, queue-bypassed, extra channels). Whoever implements
   * fetchProductPage here must route its first observation through this same gate, or the wave
   * this function prevents comes back through the loudest possible door.
   *
   * @returns {Set<string>} skus that must NOT be emitted this cycle because seeding them failed.
   *   Withholding is the safe direction: a row missing from one poll is simply not diffed (the
   *   stale path needs two consecutive misses before it touches stock, and these rows already
   *   read false), whereas emitting an unseeded row is the alert wave this function exists to
   *   prevent. The next poll retries.
   */
  async _seedFirstObservations() {
    const withhold = new Set();
    const rows = new Map();

    // Every sku with a real reading that this poll would emit. Computed BEFORE the try, because
    // the failure path needs it even when loading the seen set is what failed -- otherwise a
    // failed load withholds nothing and emits the very wave this guards against.
    //
    // Only a real reading counts here: a null verdict is the parser refusing to answer, and
    // treating that as an observation would burn the sku's one free pass on a reading that never
    // happened.
    const observed = [];
    for (const [sku, avail] of this.availabilityCache) {
      if (!avail || typeof avail.inStock !== 'boolean') continue;
      if (!this.sitemapProducts.has(sku)) continue;     // the poll would not emit it either
      observed.push(sku);
    }
    if (observed.length === 0) return { withhold, rows };

    let pending = [];
    try {
      // Load the seen set FIRST. Filtering candidates against an unloaded set made every sku on
      // the first poll of a process look like a first observation -- the entire catalogue.
      await this._loadStockSeen();
      pending = observed.filter((sku) => !this._stockSeen.has(sku));
      if (pending.length === 0) return { withhold, rows };

      const redis = state.getRedis();
      if (!redis) throw new Error('no redis connection');

      // A SKU WITH NO STORED ROW MUST NOT BE SEEDED.
      //
      // detectEvents emits NEW_SKU only when there is no old product at all. Seeding writes a row
      // before the diff runs, so seeding a genuinely new listing makes `oldProduct` exist and the
      // NEW_SKU never fires -- and _registerWithEarlyScanner has already told the 12-hourly
      // scanner to stay quiet about that URL on the assumption this adapter would announce it. A
      // brand-new in-stock product would then be announced by nothing at all, which for this store
      // is the most valuable alert it can produce.
      //
      // The seed only exists to stop a false TRANSITION, and a transition needs something to
      // transition FROM. No stored row, nothing to suppress: mark it seen and let NEW_SKU fire.
      const stored = await state.getAllProducts(this.id);
      const toSeed = pending.filter((sku) => stored[sku]);

      const pipeline = redis.pipeline();
      for (const sku of toSeed) {
        // Built ONCE and handed back to the caller. Rebuilding it after the await let a
        // fire-and-forget sweep write a new reading in between, so the row on disk could say
        // false while the row emitted said true -- manufacturing the exact restock this guards.
        const row = this._buildRow(sku, this.sitemapProducts.get(sku), this.availabilityCache.get(sku));
        rows.set(sku, row);
        // The same key, shape and TTL poll-adapter uses, so the diff sees no difference at all.
        pipeline.set(`tcg:product:${hashSku(this.id, sku)}`, JSON.stringify(row), 'EX', 86400 * 7);
      }
      pipeline.sadd(PC_STOCK_SEEN_KEY, ...pending);

      // A PIPELINE RESOLVES ON COMMAND FAILURE. ioredis fills each error into the results array
      // (Pipeline.js fillResult) and only rejects on a connection or cluster-slot error, which is
      // why state.js reads `([err, data])` on every other pipeline in this codebase. This was the
      // one call site that ignored it: an OOM or WRONGTYPE would leave every row unwritten, mark
      // all ~800 skus seen anyway, and fire the whole wave on the next poll Redis accepted -- the
      // failure this function exists to prevent, reached through its own success path.
      const results = await pipeline.exec();
      if (!Array.isArray(results)) throw new Error('pipeline returned no results');
      const failed = results.filter(([e]) => e);
      if (failed.length) throw new Error(`${failed.length}/${results.length} commands failed: ${failed[0][0].message}`);

      for (const sku of pending) this._stockSeen.add(sku);
      const inStock = toSeed.filter((s) => this.availabilityCache.get(s).inStock === true).length;
      const newListings = pending.length - toSeed.length;
      logger.info(`Pokemon Center: seeded ${toSeed.length} first stock observations `
        + `(${inStock} in stock) — no alerts fired; the next change to each is a real one`
        + `${newListings ? `; ${newListings} had no stored row and keep their NEW_SKU` : ''}`);
    } catch (err) {
      rows.clear();
      for (const sku of await this._rowsThatWouldFalselyRestock(observed)) withhold.add(sku);
      logger.warn(`Pokemon Center: first-observation seeding failed (${err.message}) — `
        + `withholding ${withhold.size} row(s) this poll rather than risk a false restock wave`);
    }
    return { withhold, rows };
  }

  /**
   * On the very first run, everything already in the availability cache counts as observed.
   *
   * WITHOUT THIS, THE GUARD SWALLOWS A REAL RESTOCK EXACTLY ONCE. availabilityCache only ever
   * holds skus that produced a genuine reading — entries are written when a check or a sweep
   * succeeds, never on failure — so every sku restored from Redis at boot has already been
   * observed and its stored product row is already correct. _seedFirstObservations() cannot tell
   * that by itself: with an empty seen set it would call all of them first observations and
   * overwrite their stored rows BEFORE the diff ran. Any sku that genuinely came back in stock
   * during that one poll would have its restock overwritten and never alerted.
   *
   * Boot is the only moment where the distinction is unambiguous, because nothing new has been
   * observed yet. So the set is established here, from the cache as restored, and from then on a
   * first observation means precisely what it should: a sku arriving in the cache that was not in
   * it before.
   *
   * Only ever runs when the set does not exist. An existing set is authoritative and is left
   * alone — re-bootstrapping over it would re-mark skus whose rows have since moved on.
   */
  async _bootstrapStockSeen() {
    try {
      const redis = state.getRedis();
      if (!redis) return;
      if (await redis.exists(PC_STOCK_SEEN_KEY)) return;

      const observed = [...this.availabilityCache.entries()]
        .filter(([, d]) => d && typeof d.inStock === 'boolean')
        .map(([sku]) => sku);
      if (observed.length === 0) return;

      await redis.sadd(PC_STOCK_SEEN_KEY, ...observed);
      for (const sku of observed) this._stockSeen.add(sku);
      this._stockSeenLoaded = true;
      logger.info(`Pokemon Center: first run — ${observed.length} cached readings recorded as `
        + `already observed; only skus read from here on are treated as first observations`);
    } catch (err) {
      // Left unloaded on purpose: _loadStockSeen will try again on the next poll.
      logger.warn(`Pokemon Center: could not establish the observed-stock set: ${err.message}`);
    }
  }

  /**
   * When seeding fails, the skus whose emission would fabricate a restock — and only those.
   *
   * Withholding is NOT free. A row missing from two consecutive polls is written inStock:false by
   * poll-adapter's stale path, so withholding an in-stock product marks it dead and then fires
   * that wave on recovery. Withholding the whole candidate list would do exactly that, and on the
   * first poll of a process -- before the seen set has loaded -- the candidate list is the entire
   * catalogue.
   *
   * So the test is not "is this a first observation" but "would emitting this look like a
   * restock": the stored row says not-in-stock, and the reading says in stock. That rule needs no
   * seen set at all, which is what makes it usable on the path where loading the seen set is the
   * thing that failed.
   *
   *   first sweep that can finally see    stored false, read true  -> withheld (the disaster set)
   *   steady-state product still in stock stored true,  read true  -> emitted  (never starved)
   *   anything reading sold out           read false               -> emitted  (raises nothing)
   *
   * If the stored rows cannot be read either, Redis is unavailable and poll-adapter's own
   * getAllProducts is about to fail too, so the poll is lost regardless; withhold nothing and say
   * so rather than starve the catalogue on the way down.
   */
  async _rowsThatWouldFalselyRestock(candidates) {
    const risky = [];
    if (!candidates || candidates.length === 0) return risky;
    let stored;
    try {
      stored = await state.getAllProducts(this.id);
    } catch (err) {
      logger.warn(`Pokemon Center: could not read stored rows to scope the withhold (${err.message}) — `
        + 'emitting normally; the guard is disarmed for this poll');
      return risky;
    }
    for (const sku of candidates) {
      const avail = this.availabilityCache.get(sku);
      if (!avail || avail.inStock !== true) continue;      // cannot read as a restock
      const prev = stored[sku];
      if (prev && prev.inStock === true) continue;         // already in stock; no transition
      // A sku already in the seen set is NOT a first observation, so its false->true is a REAL
      // restock and must go out. Only trust that when the set actually loaded: if loading it is
      // what failed, an empty set would silently reclassify every genuine restock as safe.
      if (this._stockSeenLoaded && this._stockSeen.has(sku)) continue;
      risky.push(sku);
    }
    return risky;
  }

  async _loadStockSeen() {
    if (this._stockSeenLoaded) return;
    const redis = state.getRedis();
    if (!redis) throw new Error('no redis connection');
    const members = await redis.smembers(PC_STOCK_SEEN_KEY);
    for (const sku of members || []) this._stockSeen.add(sku);
    this._stockSeenLoaded = true;
    logger.info(`Pokemon Center: ${this._stockSeen.size} skus already have an observed stock reading`);
  }

  _buildRow(sku, meta, avail) {
    const a = avail || { inStock: false, price: null, image: '' };
    return this.classify({
      sku,
      name: meta.name,
      price: a.price,
      currency: 'CAD',
      url: meta.url,
      image: a.image || '',
      inStock: a.inStock,
      canAddToCart: a.inStock,
      shipsToHome: true,
    });
  }

  _noteCheckOutcome(sku, ok) {
    // Every stock read passes through here, which makes it the honest place to count what
    // freshness reports. See the note at the reportFreshness call site.
    this._freshAttempts = (this._freshAttempts || 0) + 1;
    if (ok) {
      this._freshSuccesses = (this._freshSuccesses || 0) + 1;
      this._lastGoodReadAt = Date.now();
      this._blindWarned = false;
    }
    if (ok) {
      if (this._failStreak.delete(sku)) this._unfetchable.delete(sku);
      return;
    }
    const streak = (this._failStreak.get(sku) || 0) + 1;
    this._failStreak.set(sku, streak);
    if (streak >= UNFETCHABLE_AFTER && !this._unfetchable.has(sku)) {
      this._unfetchable.set(sku, { until: Date.now() + UNFETCHABLE_COOLDOWN_MS });
      logger.info(`Pokemon Center: parking ${sku} for ${UNFETCHABLE_COOLDOWN_MS / 3600000}h — ` +
        `${streak} total failures, the page cannot be fetched`);
    }
  }

  async _loadUnfetchable() {
    if (this._unfetchableLoaded) return;
    this._unfetchableLoaded = true;
    try {
      const raw = await state.getRedis().get(PC_UNFETCHABLE_KEY);
      if (!raw) return;
      const now = Date.now();
      for (const [sku, entry] of Object.entries(JSON.parse(raw))) {
        if (entry && entry.until > now) this._unfetchable.set(sku, entry);
      }
      if (this._unfetchable.size) logger.info(`Pokemon Center: ${this._unfetchable.size} SKUs still parked as unfetchable`);
    } catch { /* non-critical */ }
  }

  async _saveUnfetchable() {
    try {
      await state.getRedis().set(PC_UNFETCHABLE_KEY,
        JSON.stringify(Object.fromEntries(this._unfetchable)), 'EX', 86400 * 7);
    } catch { /* non-critical */ }
  }

  async _loadAvailability() {
    if (this._availabilityLoaded) return;
    this._availabilityLoaded = true;
    try {
      const raw = await state.getRedis().get(PC_AVAILABILITY_KEY);
      // No stored blob is still a load. Returning here skipped the bootstrap permanently
      // (_availabilityLoaded is already true), which was harmless only because nothing populates
      // availabilityCache before this runs -- an ordering accident, not a guarantee, and this
      // branch is heading towards a sweep that can be invoked outside the poll.
      if (!raw) { await this._bootstrapStockSeen(); return; }
      const saved = JSON.parse(raw);
      let restored = 0;
      for (const [sku, data] of Object.entries(saved)) {
        if (data && typeof data === 'object') { this.availabilityCache.set(sku, data); restored++; }
      }
      // Carry the newest stored read forward, so a redeploy does not reset the blind clock
      // and hide an outage that has been running for hours.
      let newest = 0;
      for (const d of this.availabilityCache.values()) {
        if (d && d.checkedAt > newest) newest = d.checkedAt;
      }
      if (newest > 0) this._lastGoodReadAt = newest;
      if (restored) logger.info(`Pokemon Center: restored ${restored} cached availability records`);
      await this._bootstrapStockSeen();
    } catch (err) {
      logger.warn(`Pokemon Center: could not restore availability cache: ${err.message}`);
    }
  }

  async _saveAvailability() {
    if (this.availabilityCache.size === 0) return;
    try {
      const blob = JSON.stringify(Object.fromEntries(this.availabilityCache));
      await state.getRedis().set(PC_AVAILABILITY_KEY, blob, 'EX', 86400 * 14);
    } catch (err) {
      logger.debug(`Pokemon Center: could not persist availability cache: ${err.message}`);
    }
  }

  _selectCheckTargets() {
    const now = Date.now();
    const targets = [];
    const dueWatchlist = [];

    for (const sku of this.watchlist) {
      if (!this.sitemapProducts.has(sku)) continue;
      // Same persistence problem the rotation had, one level up. _watchlistCheckedAt is
      // in-memory, so every deploy made all 57 watchlist SKUs "due" again; they always sort
      // ahead of rotation, so the same handful were re-checked forever and the catalogue
      // never advanced past them. The availability cache is persisted and records checkedAt,
      // so it is the authority on when a product was last actually read.
      const cached = this.availabilityCache.get(sku);
      const lastChecked = Math.max(cached && cached.checkedAt ? cached.checkedAt : 0,
        this._watchlistCheckedAt.get(sku) || 0);
      if (now - lastChecked < this.watchlistIntervalMs) continue;
      dueWatchlist.push([sku, lastChecked]);
    }
    // STALEST first. The batch is sliced to checksPerPoll, so pushing in Set order meant the
    // same few SKUs at the front of the config were selected every time while the rest never
    // came up — the cache sat at 17 while checks kept reporting success, because those
    // successes were re-reading products already in it.
    dueWatchlist.sort((a, b) => a[1] - b[1]);
    for (const [sku] of dueWatchlist) targets.push(sku);

    while (this._newSkuQueue.length > 0 && targets.length < this.checksPerPoll) {
      const sku = this._newSkuQueue.shift();
      if (this.sitemapProducts.has(sku) && !targets.includes(sku)) targets.push(sku);
    }

    // Rotation, only with budget left for it today.
    if (targets.length < this.checksPerPoll && this._rotationBudgetLeft() > 0) {
      const candidates = [];
      for (const sku of this.sitemapProducts.keys()) {
        if (targets.includes(sku)) continue;
        if (this._isUnfetchable(sku, now)) continue;   // don't spend the budget on a page nobody can fetch
        // Rotation progress has to survive a restart, or the sweep begins from the same
        // products every deploy and never advances. That is exactly what happened: ~10
        // deploys in one evening kept re-checking the same 17 products while the other
        // 1,178 were never looked at once, which is why the priced count froze at 17
        // even though the fetching itself was working.
        //
        // The availability cache is already persisted and already records checkedAt, so it
        // IS the rotation clock. A product with no cache entry has never been checked
        // successfully and sorts first, which is the order we want anyway.
        const cached = this.availabilityCache.get(sku);
        const lastChecked = (cached && cached.checkedAt) || this._rotationCheckedAt.get(sku) || 0;
        candidates.push([sku, lastChecked]);
      }
      candidates.sort((a, b) => a[1] - b[1]); // never-checked (0) first, then stalest
      for (const [sku] of candidates) {
        if (targets.length >= this.checksPerPoll) break;
        targets.push(sku);
        this._rotationCheckedAt.set(sku, now);
        this._rotationSpentToday += 1;
      }
    }

    // Cap at checksPerPoll, NOT max(checksPerPoll, watchlist.size).
    //
    // That max() was written when a check was fast. With Bright Data a check can take 180s,
    // and a 57-SKU watchlist therefore produced a single batch of 57 products — up to 5.7
    // HOURS of work — while the _checkRunning guard blocked every later batch behind it. The
    // symptom was "checks running" on every poll, no completion line ever, and a priced count
    // frozen at 17 while the fetch layer looked healthy.
    //
    // Watchlist SKUs still come first in the list above, so they keep their priority; they
    // are simply spread across successive batches instead of one enormous one, and
    // _watchlistCheckedAt stops each from being re-picked until its interval elapses.
    return targets.slice(0, this.checksPerPoll);
  }

  /**
   * Checks the rotation may still spend today.
   *
   * Deliberately a hard daily cap rather than a rate: the failure mode being guarded against
   * is a fast poll loop quietly draining a month of credits in a day. Defaults to 40, which is
   * the ~2/hour the budget comment in scraper-api.js was written around, and can be set to 0
   * to turn rotation off entirely and rely on the watchlist alone.
   */
  _rotationBudgetLeft() {
    const cap = this.timingValue('dailyRotationChecks', 40, 0);
    const today = new Date().toISOString().slice(0, 10);
    if (this._rotationDay !== today) {
      this._rotationDay = today;
      this._rotationSpentToday = 0;
    }
    return Math.max(0, cap - this._rotationSpentToday);
  }

  /**
   * A challenge page, as opposed to a real page that merely MENTIONS the anti-bot vendor.
   *
   * This used to match the bare strings 'distil_referrer' and 'Incapsula'. Pokemon Center
   * loads those scripts on every page it serves, including perfectly good ones, so a genuine
   * product page carrying price and availability was classified as a block and discarded.
   * Bright Data was returning real pages and every one of them was thrown away — 0 of 1,195
   * products had a price while the fetch layer reported success.
   *
   * The markers below are the interstitials themselves, not references to the vendor that
   * serves them. Anything that names a script is not evidence: the page that ships the
   * defence and the page that IS the defence both mention it.
   */
  isChallengePage(html) {
    if (!html || html.length < 500) return true; // Too short = challenge or error
    return html.includes('Pardon Our Interruption') ||
      html.includes('_Incapsula_Resource') ||
      html.includes('captcha-delivery') ||
      html.includes('Access Denied') ||
      html.includes('Please verify you are a human') ||
      (html.length < 5000 && !html.includes('<loc>') && !html.includes('<html'));
  }

  async fetchProducts() {
    // Legacy rows stored before this adapter applied the shared scope rule never expire on their
    // own: a re-polled row keeps refreshing lastSeen, so age-based expiry can never reach it.
    // Cleared once per process rather than every poll, since it scans the retailer keyspace.
    // dryRun mirrors the ingestion gate — it reports what it would delete until enforcement is on.
    this._maybePurgeOutOfScope();

    const products = {};

    // Phase 1: Discover products from sitemap (every 4 hours)
    // NEVER throw if sitemap fails — use cached products instead
    if (Date.now() - this.lastSitemapScan > this.sitemapIntervalMs || this.sitemapProducts.size === 0) {
      try {
        await this.scanSitemap();
        this.lastSitemapScan = Date.now();
      } catch (err) {
        if (this.sitemapProducts.size > 0) {
          logger.warn(`Pokemon Center: sitemap failed (${err.message}), using ${this.sitemapProducts.size} cached products`);
        } else {
          // No cached products — this is the only case we propagate the error
          throw new Error(`Pokemon Center: no products — sitemap failed: ${err.message}`);
        }
      }
    }

    if (this.sitemapProducts.size === 0) {
      throw new Error('No TCG products in sitemap cache');
    }

    // Phase 2: paid availability checks, kicked off in the BACKGROUND.
    //
    // These used to run inside the poll, and that was the wrong shape. Bright Data answers
    // Pokemon Center in 16-99s, and instrumenting the failures showed why: every single one
    // was HTTP 200 with an empty body after 59-99 seconds. Not our timeout — Bright Data
    // giving up internally. A retry fixes those, but a retry could not fit inside a poll that
    // also has to stay fast, so the fix kept colliding with the deadline: 120s adapter
    // timeouts, then a 70s budget, then 150s, each one trading coverage against latency.
    //
    // Decoupling removes the trade entirely. The sitemap phase — free, fast, and the only
    // thing that spots a NEW listing — returns immediately with whatever availability is
    // cached. The paid check updates that cache whenever it finishes, however long it takes.
    await this._loadAvailability();
    await this._loadUnfetchable();

    const paidDue = Date.now() - this._lastPaidCheckAt >= this.paidCheckIntervalMs;
    if (paidDue && !this._checkRunning) {
      const targets = this._selectCheckTargets();
      if (targets.length > 0) {
        this._lastPaidCheckAt = Date.now();
        this._checkRunning = true;
        // Deliberately not awaited.
        this._runChecks(targets)
          .catch(err => logger.warn(`Pokemon Center: background check failed: ${err.message}`))
          .finally(() => { this._checkRunning = false; });
      }
    }

    // Bulk in-stock sweep. Runs alongside the per-product checks rather than replacing them:
    // the sweep gives broad, cheap coverage of WHICH products are in stock, the per-product
    // checks give precision on the watchlist and on anything the listing does not carry.
    // Also not awaited — a poll must never wait on a paid path.
    if (Date.now() - this._lastCategorySweepAt >= this.categorySweepIntervalMs && !this._categorySweepRunning) {
      this._lastCategorySweepAt = Date.now();
      this._categorySweepRunning = true;
      this._sweepCategories()
        .then(() => this._saveAvailability())
        .catch(err => logger.warn(`Pokemon Center: category sweep failed: ${err.message}`))
        .finally(() => { this._categorySweepRunning = false; });
    }

    // Phase 3: Build the product list from cached availability.
    //
    // The paid checks are asynchronous now, so this poll reports what is KNOWN rather than
    // what was just fetched. Freshness and failure tracking moved into _runChecks with them —
    // leaving them here referenced a batch size that no longer exists and threw
    // "batchSize is not defined" on every poll.
    // Must run BEFORE these rows are returned: poll-adapter reads the old state to diff against
    // only after run() resolves, so a row seeded here is already in place when the diff happens.
    const { withhold, rows: seededRows } = await this._seedFirstObservations();

    for (const [sku, meta] of this.sitemapProducts) {
      if (withhold.has(sku)) continue;
      // Reuse the exact object that was written to Redis. Rebuilding it here would re-read
      // availabilityCache, which the sweeps mutate from outside this poll.
      products[sku] = seededRows.get(sku) || this._buildRow(sku, meta, this.availabilityCache.get(sku));
    }

    // Freshness must describe STOCK DETECTION, not the sitemap.
    //
    // This used to report `availabilityCache.size` against `sitemapProducts.size`. The cache is
    // restored from Redis at boot and only ever grows, so the fresh count could never fall to
    // zero and `zeroFreshPolls` could never trip. The consequence was measured on 2026-09-11:
    // Bright Data's account had been suspended, 188 consecutive stock checks returned nothing,
    // every one of 805 products read out of stock — and /api/health still said
    // `healthy: true, stale: false, servingStaleData: false`. The store was totally blind and
    // the one signal built to say so was reporting the size of a cache.
    //
    // Report the outcome of the checks instead: of the stock reads attempted since the last
    // poll, how many actually produced data. When nothing was due, say nothing at all rather
    // than inventing a healthy sample — poll-adapter simply skips a null reading.
    if (this._freshAttempts > 0) {
      this.reportFreshness(this._freshSuccesses, this._freshAttempts);
      this._freshAttempts = 0;
      this._freshSuccesses = 0;
    } else if (this.sitemapProducts.size > 0
        && Date.now() - this._lastGoodReadAt >= STOCK_BLIND_MS) {
      // Nothing was even ATTEMPTED, and it has been far too long since anything was read.
      //
      // Reporting only on attempts is not enough, which the live store proved: with the paid
      // account suspended, the rotation budget was spent on failures, every product parked for
      // 12h after two failures, and the poll line settled into "0 queued, 322 parked, checks
      // idle". No attempts means no samples means health stays green — a store that has given
      // up looks identical to a store with nothing due.
      //
      // A catalogue we cannot read is not healthy, however tidily it stopped trying.
      this.reportFreshness(0, 1);
      if (!this._blindWarned) {
        this._blindWarned = true;
        const hrs = Math.round((Date.now() - this._lastGoodReadAt) / 3600000);
        logger.error(`Pokemon Center: no successful stock read in ${hrs}h across `
          + `${this.sitemapProducts.size} products — detection is DOWN, not merely quiet.`);
      }
    }

    // A store that cannot check anything cannot detect a restock, and must not read as a
    // normal cycle. Kept from the previous shape because the failure it warns about is real.
    if (this.watchlist.size === 0 && this.availabilityCache.size === 0
        && this._rotationBudgetLeft() === 0) {
      logger.warn(`Pokemon Center: ${Object.keys(products).length} products, but watchlist EMPTY `
        + 'and rotation budget spent, so no restock can be detected. '
        + 'Add SKUs to the watchlist or raise dailyRotationChecks.');
    }


    logger.info(`Pokemon Center: ${Object.keys(products).length} products ` +
      `(${this.availabilityCache.size} with known stock, ${this._newSkuQueue.length} queued, ` +
      `${this._unfetchable.size} parked, checks ${this._checkRunning ? 'running' : 'idle'})`);
    return products;
  }

  async scanSitemap() {
    let xml;

    // Method 1: Stealth HTTP (impit) — fastest, free, works if sitemap isn't behind challenge
    try {
      const proxyUrl = getProxyUrl('residential');
      const conditional = this._sitemapValidators || {};
      const res = await stealthGet(this.sitemapUrl, {
        proxyUrl,
        maxRetries: 2,
        timeoutMs: 30000,
        withResponse: true,
        headers: {
          'Accept': 'application/xml, text/xml, */*',
          ...(conditional.etag ? { 'If-None-Match': conditional.etag } : {}),
          ...(conditional.lastModified ? { 'If-Modified-Since': conditional.lastModified } : {}),
        },
      });
      if (res && res.status === 304) {
        // Unchanged since last look — no new listings, nothing to parse, no bytes moved.
        return;
      }
      xml = res && res.body;
      if (xml && xml.includes('<loc>') && !this.isChallengePage(xml)) {
        const etag = res.headers['etag'];
        const lastModified = res.headers['last-modified'];
        if (etag || lastModified) this._sitemapValidators = { etag, lastModified };
        logger.info('Pokemon Center: sitemap fetched via stealth HTTP (free)');
        this._parseSitemap(xml);
        return;
      }
      logger.debug('Pokemon Center: stealth HTTP sitemap returned challenge/empty');
    } catch (err) {
      logger.debug(`Pokemon Center: stealth HTTP sitemap failed: ${err.message}`);
    }

    // Method 2: Cookie-assisted fetch (Patchright cookies + impit)
    try {
      xml = await this.cookieFetch(this.sitemapUrl, {
        domain: this.domain,
        seedUrl: this.seedUrl,
        challengeDetector: (h) => !h.includes('<loc>') || this.isChallengePage(h),
        timeoutMs: 45000,
      });
      if (xml && xml.includes('<loc>') && !this.isChallengePage(xml)) {
        logger.info('Pokemon Center: sitemap fetched via cookie fetch');
        this._parseSitemap(xml);
        return;
      }
    } catch (err) {
      logger.debug(`Pokemon Center: cookieFetch sitemap failed: ${err.message}`);
    }

    // Method 3: protectedFetch (browser → ScraperAPI)
    try {
      xml = await this.protectedFetch(this.sitemapUrl, {
        timeoutMs: 45000,
        challengeDetector: (h) => !h.includes('<loc>') || this.isChallengePage(h),
        scraperOpts: { render: false, ultraPremium: true },
      });
      if (xml && xml.includes('<loc>') && !this.isChallengePage(xml)) {
        logger.info('Pokemon Center: sitemap fetched via protectedFetch');
        this._parseSitemap(xml);
        return;
      }
    } catch (err) {
      logger.debug(`Pokemon Center: protectedFetch sitemap failed: ${err.message}`);
    }

    // All methods failed — keep existing cached products
    if (this.sitemapProducts.size > 0) {
      logger.warn(`Pokemon Center: all sitemap methods failed, keeping ${this.sitemapProducts.size} cached products`);
      return;
    }
    throw new Error('Sitemap unreachable and no cached products');
  }

  /**
   * Mark URLs as already-known in the early-SKU scanner's Redis set, so it does not raise a
   * duplicate alert for something this adapter has already reported.
   */
  _registerWithEarlyScanner(rawUrls) {
    if (!rawUrls || rawUrls.length === 0) return;
    try {
      const redis = state.getRedis();
      if (!redis) return;
      // Fire-and-forget: de-duplication must never delay or break detection.
      redis.sadd('tcg:sitemap:pokemoncenter:known', ...rawUrls)
        .then(() => redis.expire('tcg:sitemap:pokemoncenter:known', 86400 * 30))
        .catch((err) => logger.debug(`Pokemon Center: early-scanner dedup failed: ${err.message}`));
    } catch (err) {
      logger.debug(`Pokemon Center: early-scanner dedup skipped: ${err.message}`);
    }
  }

  /**
   * Bulk in-stock sweep from the category listing.
   *
   * Per-product checks are the only precise source, but they cost one Bright Data request each
   * against a 1,195-product catalogue, so coverage accumulates over days and roughly a quarter
   * of the catalogue is unreachable behind expect_element. This path reads the same fact for
   * the whole category in about five requests.
   *
   * What is and is not trustworthy on these pages was measured, not assumed:
   *   - ld+json `availability` is a CONSTANT here. Across 101 products on three different
   *     category pages it said OutOfStock every single time, including for products whose own
   *     product page said InStock. It is never read.
   *   - `?availability=true` IS a real server-side filter. It drops totalResults from 973 to
   *     137, matching the page's own availability_status facet count exactly.
   *   - sku (in `mpn`, since `sku` ships empty), name and price ARE accurate: the price for
   *     10-10320-101 matched its product page to the cent.
   * So membership of the filtered listing is the stock signal; the ld+json availability field
   * beside it is ignored.
   */
  async _sweepCategories() {
    if (!brightData.isConfigured()) return;

    // DISABLED 2026-09-11 — this lane's premise is no longer true.
    //
    // Everything below rests on `?availability=true` being a real server-side filter, so that
    // MEMBERSHIP of the returned listing means "in stock". That was measured true when this was
    // written (973 -> 137, matching the facet). It is now measured FALSE: on 2026-09-11 the
    // filtered and unfiltered URLs returned a byte-identical product set — same 31 products in
    // the same order — via a real browser navigation AND via a raw same-origin fetch. The
    // per-product `availability` sitting beside them is a constant `OutOfStock` (verified
    // against a product whose own page says InStock) and its currency is USD, not CAD.
    //
    // So the sweep would now read the WHOLE category and mark every product in it inStock:true.
    // Redis currently holds all 805 rows as out of stock, so the first sweep after the Bright
    // Data account is un-suspended would fire a mass false RESTOCK — up to ~973 events against
    // a limiter that mutes at 120/min and then discards the remainder PERMANENTLY.
    //
    // Only the FACET counts on that page are still accurate (IN_STOCK 136 / OUT_OF_STOCK 837),
    // which is why this is disabled rather than deleted: re-verify that the filter filters, and
    // this lane can come back. Set PC_CATEGORY_SWEEP=1 to re-enable after verifying.
    if (process.env.PC_CATEGORY_SWEEP !== '1') {
      if (!this._sweepDisabledLogged) {
        this._sweepDisabledLogged = true;
        logger.warn('Pokemon Center: category sweep is DISABLED — the ?availability=true filter '
          + 'no longer filters, so listing membership would mark the whole category in stock. '
          + 'Re-verify the filter, then set PC_CATEGORY_SWEEP=1.');
      }
      return;
    }

    const fresh = new Map();  // sku -> { price, name }
    let complete = true;

    // Page 1 first and alone: it carries the availability facet, which says how many products
    // there are to collect and therefore how many pages to ask for.
    const first = await this._fetchCategoryPage(1);
    if (!first) {
      logger.info('Pokemon Center: category sweep — page 1 unavailable, nothing swept');
      return;
    }
    for (const r of this._parseCategoryHtml(first)) fresh.set(r.sku, r);

    const facet = first.match(/"availability_status":\s*\[\s*\{\s*"name":\s*"IN_STOCK",\s*"count":\s*(\d+)/);
    const expected = facet ? Number(facet[1]) : null;
    const perPage = Math.max(fresh.size, 1);
    const pages = expected
      ? Math.min(Math.ceil(expected / perPage), CATEGORY_MAX_PAGES)
      : 1;

    // The remaining pages are independent, and each one takes 40-100s against this site.
    // Fetched sequentially a five-page sweep outlives its own interval, so they go in parallel
    // with a small cap. A page that fails only costs completeness — never a false clear.
    const rest = [];
    for (let p = 2; p <= pages; p++) rest.push(p);
    for (let i = 0; i < rest.length; i += CATEGORY_CONCURRENCY) {
      const batch = rest.slice(i, i + CATEGORY_CONCURRENCY);
      const htmls = await Promise.all(batch.map((p) => this._fetchCategoryPage(p)));
      for (const html of htmls) {
        if (!html) { complete = false; continue; }
        for (const r of this._parseCategoryHtml(html)) fresh.set(r.sku, r);
      }
    }

    // The facet tells us how many in-stock products there should be, so a short sweep is
    // detectable rather than silently looking like "everything sold out".
    if (expected === null || fresh.size < expected) complete = false;

    let marked = 0;
    for (const [sku, row] of fresh) {
      if (!this.sitemapProducts.has(sku)) continue;  // out of scope or not in our catalogue
      const prev = this.availabilityCache.get(sku) || {};
      this.availabilityCache.set(sku, {
        inStock: true,
        price: row.price != null ? row.price : (prev.price ?? null),
        image: prev.image || '',
      });
      marked++;
    }

    // The absent-means-gone half is applied ONLY to SKUs a previous COMPLETE sweep reported in
    // stock, and only when this sweep is also complete. That is the same rule the EB Games deep
    // crawl needed: a partial read that is treated as authoritative deletes a live catalogue in
    // one step and fires a burst of false out-of-stock transitions.
    let cleared = 0;
    if (complete) {
      for (const sku of this._categoryInStock) {
        if (fresh.has(sku)) continue;
        if (!this.sitemapProducts.has(sku)) continue;
        const prev = this.availabilityCache.get(sku);
        if (!prev || !prev.inStock) continue;
        this.availabilityCache.set(sku, { ...prev, inStock: false });
        cleared++;
      }
      this._categoryInStock = new Set(fresh.keys());
    }

    logger.info(`Pokemon Center: category sweep — ${fresh.size} listed in stock` +
      `${expected !== null ? `/${expected} expected` : ''}, ${marked} matched our catalogue` +
      `${complete ? `, ${cleared} cleared` : ', PARTIAL (no clearing)'}`);
  }

  /**
   * One category listing page. These render slowly enough that a single unlock attempt is not
   * a fair test — a page measured 43s, 50s and 52s on success but also returned empty after
   * 98s with networkidle_event_timeout, so one extra attempt is worth it before giving up.
   */
  async _fetchCategoryPage(page) {
    const url = `${CATEGORY_URL}?availability=true${page > 1 ? `&page=${page}` : ''}`;
    for (let attempt = 1; attempt <= CATEGORY_PAGE_ATTEMPTS; attempt++) {
      const { html } = await brightData.unlock(url, { label: `category-p${page}`, url });
      if (html) return html;
    }
    return null;
  }

  /** SKU, name and price from a category listing. Availability here is deliberately ignored. */
  _parseCategoryHtml(html) {
    const out = [];
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
      let json;
      try { json = JSON.parse(m[1].trim()); } catch { continue; }
      if (json['@type'] !== 'Product') continue;
      const offer = Array.isArray(json.offers) ? json.offers[0] : json.offers;
      // `sku` is present but empty on these pages; mpn carries the real id, and the product
      // URL is the fallback. The carousel cells have neither and drop out here.
      const sku = json.mpn
        || (String((offer && offer.url) || json.url || '').match(/\/product\/([^/]+)\//) || [])[1]
        || null;
      if (!sku) continue;
      const price = offer && offer.price != null ? Number(offer.price) : null;
      out.push({ sku, name: json.name || '', price: Number.isFinite(price) && price > 0 ? price : null });
    }
    return out;
  }

  /**
   * Sweep this store's category pages with a HEADED browser and read stock from what renders.
   *
   * WHY A HEADED BROWSER, AND WHY THAT IS NOT PARANOIA
   * --------------------------------------------------
   * Measured 2026-09-13, all from this container, all against the same category URL:
   *
   *   stealth GET, residential / datacenter / direct   403
   *   /_next/data/<build>/....json                     403
   *   Patchright HEADLESS, direct and via residential  Imperva interstitial, escalates to hCaptcha
   *   full Chromium --headless=new, both exits         same interstitial, never clears
   *   HEADED Chromium under Xvfb, residential          RENDERS -- prices, SOLD OUT, the lot
   *
   * The same container gets clean 200s on /robots.txt and /sitemaps/* throughout, so this was
   * never an IP ban. HEADLESS is the signal being fingerprinted, and a virtual display is the
   * whole difference. See the Dockerfile for the two packages that make it possible.
   *
   * WHY EXTRACTION HAPPENS IN THE PAGE
   * ----------------------------------
   * An earlier version of this posted rendered HTML to an ingest route and regexed it there. That
   * failed on real markup -- 33 of 34 tiles unreadable, 0 prices -- because tile boundaries are
   * not recoverable from a flat HTML string: the mega-menu carries its own /en-ca/product/ links,
   * and a price sits several elements above the anchor. In the page, `innerText` of the nearest
   * priced ancestor gives exactly the tile a shopper sees, so the extraction below is the same
   * thing a human reads.
   *
   * THE SAFETY RULE: a tile that yields no definite verdict is UNKNOWN, never a guess. Unknown
   * rows are dropped, so a parser that goes blind produces SILENCE rather than a restock wave.
   *
   * @returns {{pages:number, products:number, inStock:number, outOfStock:number, unknown:number}}
   */
  async sweepCategoryHeaded(slug, opts = {}) {
    const maxPages = Math.max(1, Number(opts.maxPages) || PC_SWEEP_MAX_PAGES);
    const base = `https://www.pokemoncenter.com/en-ca/category/${slug}`;
    const { chromium } = require('patchright');

    const proxyUrl = getProxyUrl('residential');
    if (!proxyUrl) throw new Error('no residential proxy configured');
    const u = new URL(proxyUrl);

    const rows = new Map();
    let pages = 0;
    let refused = 0;      // pages the store would not serve — NOT the end of the catalogue
    let ctx;
    try {
      ctx = await chromium.launchPersistentContext(PC_BROWSER_PROFILE, {
        headless: false,                       // load-bearing; see above
        channel: 'chromium',
        proxy: {
          server: `${u.protocol}//${u.hostname}:${u.port}`,
          username: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
        },
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
        viewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });
      const page = ctx.pages()[0] || await ctx.newPage();

      for (let n = 1; n <= maxPages; n += 1) {
        // Always a real navigation, never the pager or the page-size control. Probe 4 measured
        // what driving this store's own UI costs: the in-app route change fires the
        // DataDome-protected /tpci-ecommweb-api/search endpoint, which 403s and draws a captcha,
        // and __NEXT_DATA__ is left frozen on the previous page's payload because a client-side
        // transition never rewrites that script tag. Plain document loads render every time.
        const url = pcCategoryUrl(base, n, PC_PAGE_SIZE);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PC_PAGE_TIMEOUT_MS });
        await page.waitForTimeout(PC_RENDER_WAIT_MS);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1500);

        let found = await page.evaluate(pcExtractTiles);

        // An empty page is the end of the category -- page 20 of trading-card-game returns zero
        // tiles while page 8 returns 34. That is the only pagination signal the site gives: there
        // are no pager links in the DOM at all, though ?page=N itself works.
        //
        // But an empty page is ALSO what a slow client-side render looks like, and the two are
        // indistinguishable from one sample. Measured: a sweep of pages 1-4 stopped at page 3
        // with zero tiles, on a category whose pages 5 and 8 each carry 34. Treating that as the
        // end truncates the catalogue silently -- the sweep reports success, most products are
        // never looked at, and their stored stock quietly goes stale.
        //
        // So an empty page is re-read once, with a longer wait, before it is believed.
        if (found.length === 0) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PC_PAGE_TIMEOUT_MS });
          await page.waitForTimeout(PC_RENDER_WAIT_MS * 2);
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(2500);
          found = await page.evaluate(pcExtractTiles);
          if (found.length > 0) {
            logger.debug(`Pokemon Center: ${slug} page ${n} was empty on first read, `
              + `${found.length} tiles on retry`);
          }
        }

        pages += 1;
        // Per-page accounting, because a sweep total hides exactly the failure that matters.
        //
        // Measured 2026-09-13: a 6-page sweep reported 129 products / 0 sold out and stopped at
        // page 5, while DIRECT reads of ?page=5 and ?page=8 minutes earlier returned 24 and 32
        // sold-out tiles. Page 8 plainly exists, so "page 6 is empty" was wrong — and the stop
        // landed precisely where sold-out items begin. A single total cannot distinguish "the
        // category ended" from "sequential paging silently stopped advancing", and the second
        // costs the client every out-of-stock transition in the store.
        const so = found.filter((r) => /sold\s*out/i.test(r.text)).length;
        // The landed URL matters as much as the count: if this SPA drops ?page=N on a same-session
        // navigation and serves page 1 again, every "page" would return the same in-stock head of
        // the catalogue — which is exactly what 129 products / 0 sold out looks like.
        const landed = page.url().replace('https://www.pokemoncenter.com/en-ca/category/', '');
        logger.info(`Pokemon Center: SWEEP ${slug} page ${n} — ${found.length} tiles, `
          + `${so} sold out, landed=${landed}`);
        // Measure the JSON in the same document against the tiles, and trust nothing from its
        // VERDICTS yet. Its presence, however, is trusted -- see below.
        const parsed = await this._crossCheckNextData(page, slug, n, found);

        // A REFUSED PAGE IS NOT THE END OF A CATEGORY.
        //
        // Breaking on `found.length === 0` cannot tell those apart, and the cadence run of
        // 2026-09-17 produced exactly the case that matters: pages 1 and 2 returned 95 and 96
        // products, page 3 came back 403 with ZERO bytes of __NEXT_DATA__, two stray requests and
        // no app at all. The catalogue was not finished -- page 8 at ps=32 carried 34 tiles on
        // 2026-09-13, so there are at least 258 products and page 3 at ps=96 was owed about 66.
        // The old logic would have broken there, reported success, and silently dropped a third
        // of the store, which is the failure already on the record in the note above.
        //
        // __NEXT_DATA__ is the discriminator, and it is free: it is server-rendered and present
        // before hydration, so an ENDED category still ships it with an empty product array while
        // a refused page ships no app at all. This uses only the COUNT, never a stock verdict, so
        // it is fully compatible with the observe-only stance on `outOfStock`.
        if (!parsed) {
          refused += 1;
          logger.warn(`Pokemon Center: SWEEP ${slug} page ${n} REFUSED — no product data in the `
            + `document (tiles=${found.length}). Not treating this as the end of the category.`);
          break;
        }
        if (parsed.products.length === 0) {
          logger.info(`Pokemon Center: SWEEP ${slug} page ${n} is genuinely empty — category ends`);
          break;
        }
        // A page that renders only some of its tiles is not a complete page. At ps=32 a partial
        // render mostly showed up as an outright zero; at 96 the window is three times wider and
        // the render waits were never re-tuned. The JSON says how many there should be.
        if (found.length < parsed.products.length) {
          logger.warn(`Pokemon Center: SWEEP ${slug} page ${n} PARTIAL — ${found.length} tiles `
            + `rendered of ${parsed.products.length} products in the document`);
        }
        if (found.length === 0) break;
        // The verdict is applied HERE, in Node, where it is testable — see pcVerdict().
        for (const r of found) {
          if (rows.has(r.sku)) continue;
          const v = pcVerdict(r.text);
          rows.set(r.sku, {
            sku: r.sku, name: pcNameFromSlug(r.slug), price: v.price, inStock: v.inStock,
          });
        }
        await sleep(PC_PAGE_SPACING_MS);
      }
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }

    const all = [...rows.values()];
    const inStock = all.filter((r) => r.inStock === true);
    const outOfStock = all.filter((r) => r.inStock === false);
    const unknown = all.filter((r) => r.inStock == null);

    logger.info(`Pokemon Center: SWEEP ${slug} — ${pages} page(s), ${all.length} products, `
      + `${inStock.length} in stock, ${outOfStock.length} sold out, ${unknown.length} unreadable`
      + `${refused ? `, INCOMPLETE — stopped on a refused page, coverage is partial` : ''}`);

    if (process.env.PC_BROWSER_ALERTS !== '1') {
      // OBSERVE-ONLY, and deliberately the default.
      //
      // Every stored Pokemon Center row sits at inStock:false because nothing could ever see
      // stock -- not because the product is out of stock. The first sweep that CAN see would
      // therefore read as a restock on every available product at once (~135 in this category
      // alone) straight into the client's paid channel. Those are first observations, not
      // restocks, and nothing in the stored state distinguishes them.
      //
      // So the first runs measure. Seeding gets wired against real numbers, then alerts go on.
      logger.info('Pokemon Center: SWEEP observe-only (set PC_BROWSER_ALERTS=1 to write)');
      return { pages, refused, incomplete: refused > 0, products: all.length, inStock: inStock.length,
        outOfStock: outOfStock.length, unknown: unknown.length };
    }

    for (const r of all) {
      if (r.inStock == null) continue;          // never store a guess
      const prev = this.availabilityCache.get(r.sku) || {};
      this.availabilityCache.set(r.sku, {
        inStock: r.inStock,
        price: r.price != null ? r.price : (prev.price != null ? prev.price : null),
        image: prev.image || '',
        checkedAt: Date.now(),
      });
      this._noteCheckOutcome(r.sku, true);
    }
    await this._saveAvailability();

    return { pages, refused, incomplete: refused > 0, products: all.length, inStock: inStock.length,
      outOfStock: outOfStock.length, unknown: unknown.length };
  }

  /**
   * Compare the products in the page's __NEXT_DATA__ against the tiles just scraped from it.
   *
   * OBSERVE-ONLY, AND DELIBERATELY SO. Probe 3 (2026-09-15) found the grid's products at
   * $.props.initialState.search.results.products with a boolean `outOfStock`, structured prices
   * and clean SKUs -- strictly better data than tile text, from a document this sweep already
   * loads. It is not promoted to the source of truth here for one reason: that page had 31 of 31
   * products IN STOCK, so `outOfStock: true` has never been observed on this store. The field
   * name is not ambiguous, but the Amazon seller gate went silently blind on exactly this kind of
   * reasonable assumption, and a stock parser that is wrong in the sold-out direction marks a
   * live catalogue dead and then fires a restock for all of it on recovery.
   *
   * So: log agreement, change nothing. One paced sweep that reaches a page with sold-out products
   * (page 8 of trading-card-game measured 32 of 34 sold out) turns the remaining assumption into
   * a measurement, and then the switch is a one-line change with numbers behind it.
   *
   * Never throws: a cross-check that breaks the sweep it is measuring is worse than no data.
   */
  async _crossCheckNextData(page, slug, n, found) {
    try {
      const text = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__');
        return el ? el.textContent : null;
      }).catch(() => null);

      const parsed = pcProductsFromNextData(text);
      if (!parsed) {
        // Not an empty catalogue -- the shape moved, or this document was never the grid.
        logger.info(`Pokemon Center: JSONCHECK ${slug} page ${n} — no products array `
          + `(nextData=${text ? `${text.length}B` : 'absent'}), tiles=${found.length}`);
        return null;
      }

      const json = new Map(parsed.products.map((p) => [p.sku, p]));
      const dom = new Map(found.map((r) => [r.sku, pcVerdict(r.text)]));

      // Every skipped comparison is attributed. Reporting only `unreadable(json)` left a tile
      // unaccounted for with no way to tell which side refused -- and producing exactly this
      // evidence is the only reason this function exists.
      let agree = 0;
      let differ = 0;
      let skippedDom = 0;
      let skippedJson = 0;
      const examples = [];
      for (const [sku, v] of dom) {
        const j = json.get(sku);
        if (!j) continue;                                   // counted as domOnly below
        if (v.inStock == null) { skippedDom += 1; continue; }
        if (j.inStock == null) { skippedJson += 1; continue; }
        if (j.inStock === v.inStock) { agree += 1; continue; }
        differ += 1;
        if (examples.length < 5) examples.push(`${sku} dom=${v.inStock} json=${j.inStock}`);
      }

      // domOnly is the number this is really watching: those are the mega-menu's product links,
      // which the tile selector cannot tell from the grid. Probe 3 measured 33 anchors for 31
      // products, and the two extras were the two tiles the verdict had to refuse.
      const domOnly = [...dom.keys()].filter((s) => !json.has(s));
      const jsonOnly = [...json.keys()].filter((s) => !dom.has(s));
      const jsonSoldOut = parsed.products.filter((p) => p.inStock === false).length;
      const jsonUnknown = parsed.products.filter((p) => p.inStock == null).length;

      // `first` identifies WHICH page this payload actually is. __NEXT_DATA__ is only valid for
      // the document as loaded, and a frozen payload from a client-side transition would
      // otherwise have to be inferred from domOnly and jsonOnly both going to the page size.
      const first = parsed.products.length ? parsed.products[0].sku : '-';
      logger.info(`Pokemon Center: JSONCHECK ${slug} page ${n} — json=${parsed.products.length} `
        + `tiles=${found.length}, agree=${agree} differ=${differ}, `
        + `skipped=${skippedDom + skippedJson} (dom ${skippedDom}/json ${skippedJson}), `
        + `soldOut(json)=${jsonSoldOut} unreadable(json)=${jsonUnknown} dropped(json)=${parsed.dropped || 0}, `
        + `domOnly=${domOnly.length}${domOnly.length ? ` [${domOnly.slice(0, 5).join(',')}]` : ''}, `
        + `jsonOnly=${jsonOnly.length}${jsonOnly.length ? ` [${jsonOnly.slice(0, 5).join(',')}]` : ''}, `
        + `first=${first}`
        + `${differ ? ` — DISAGREE: ${examples.join('; ')}` : ''}`);
      return parsed;
    } catch (err) {
      // `err.message` on its own would throw for a non-Error throwable, inside the one function
      // in this file that promises never to throw — and its call site in the sweep is unguarded.
      logger.warn(`Pokemon Center: JSONCHECK ${slug} page ${n} failed: ${(err && err.message) || err}`);
      return null;   // a cross-check that cannot read the page must not vouch for it
    }
  }

  /**
   * The store's category slugs, from the categories sitemap.
   *
   * Free and unguarded -- the same surface that already gives this adapter its product list, and
   * what lets a sweep cover the WHOLE store rather than a hardcoded TCG subset.
   */
  async listCategorySlugs() {
    // Residential exit, matching scanSitemap(). The container's DIRECT exit was reputation-
    // flagged by this host on 2026-09-13 and was still serving "Pardon Our Interruption" twelve
    // minutes later, while the residential exit stayed clean throughout -- so this must not
    // quietly fall back to no proxy.
    const xml = await stealthGet('https://www.pokemoncenter.com/sitemaps/categories.xml', {
      proxyUrl: getProxyUrl('residential'),
      maxRetries: 2,
      timeoutMs: 30000,
      headers: { 'Accept': 'application/xml, text/xml, */*' },
    });
    if (!xml || !xml.includes('<loc>') || this.isChallengePage(xml)) {
      throw new Error('categories sitemap unavailable');
    }
    const slugs = new Set();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const hit = m[1].match(/\/category\/([^/?#<]+)/);
      if (hit && hit[1]) slugs.add(hit[1]);
    }
    return [...slugs];
  }

  _parseSitemap(xml) {
    const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
    const newProducts = new Map();

    for (const match of urlMatches) {
      const url = match.replace(/<\/?loc>/g, '');
      if (!url.includes('/product/')) continue;

      const parts = url.split('/');
      const slug = parts[parts.length - 1] || '';
      const sku = parts[parts.length - 2] || '';
      if (!sku || !slug) continue;

      const lowerSlug = slug.toLowerCase();
      if (!this.tcgKeywords.some(kw => lowerSlug.includes(kw))) continue;

      const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      // The shared scope rule, applied to the exact name an alert would carry.
      if (!isInScopeName(name)) continue;

      // The sitemap lists each SKU about four times, once per locale — 34,572 URLs for 8,415
      // products. Only the locale PREFIX was being rewritten, and only for en-*, so a
      // /de-de/ entry survived intact:
      //
      //   /de-de/product/70-10984/gengar-lila-langaermliges-schlafshirt-erwachsene
      //
      // The slug is the name we alert under, and the page it points at quotes EUR. While the
      // catalogue was TCG-only this was mostly hidden; widening to the whole store surfaced it
      // immediately — a German sleep shirt was in the live work queue within minutes.
      //
      // So rewrite ANY locale to en-ca, and when the same SKU appears more than once keep the
      // variant with an ENGLISH slug. The prefix decides the page; the slug decides the name,
      // and only an English-sourced slug gives an English name.
      const caUrl = url
        .replace(/^(https?:\/\/[^/]+)\/[a-z]{2}-[a-z]{2}\/product\//i, '$1/en-ca/product/')
        .replace(/^(https?:\/\/[^/]+)\/product\//, '$1/en-ca/product/');

      // Bare /product/ and /en-*/ carry English slugs; anything else does not.
      const english = !/^https?:\/\/[^/]+\/(?!en-)[a-z]{2}-[a-z]{2}\/product\//i.test(url);
      const existing = newProducts.get(sku);
      if (existing && existing.english && !english) continue;   // keep the English one

      newProducts.set(sku, { url: caUrl, name, rawUrl: url, english });
    }

    if (newProducts.size > 0) {
      this.sitemapProducts = newProducts;

      // Diff against what we have seen before — the sitemap is the only free signal this
      // site gives us, so a sku appearing here is what earns a paid availability check.
      if (!this._seededSkus) {
        for (const sku of newProducts.keys()) this._knownSkus.add(sku);
        this._seededSkus = true;
        logger.info(`Pokemon Center: sitemap parsed — ${newProducts.size} TCG products seeded (${urlMatches.length} total URLs)`);
      } else {
        const appeared = [];
        for (const sku of newProducts.keys()) {
          if (this._knownSkus.has(sku)) continue;
          this._knownSkus.add(sku);
          appeared.push(sku);
        }
        // Register these with the 12-hourly early-SKU scanner, which diffs the SAME sitemap
        // against its own Redis set. This adapter now checks that sitemap every ~8s, so it
        // always sees a new listing first; without this the scanner would rediscover the same
        // product hours later and fire a second, duplicate alert for it.
        this._registerWithEarlyScanner(appeared.map((s) => newProducts.get(s)?.rawUrl).filter(Boolean));

        for (const sku of appeared) {
          if (!this._newSkuQueue.includes(sku)) this._newSkuQueue.push(sku);
        }
        logger.info(`Pokemon Center: sitemap parsed — ${newProducts.size} TCG products (${urlMatches.length} total URLs)${appeared.length ? `, ${appeared.length} newly listed` : ''}`);
      }
    } else if (urlMatches.length > 0) {
      logger.warn(`Pokemon Center: sitemap had ${urlMatches.length} URLs but 0 passed the scope rule`);
    }
  }

  async checkProductAvailability(sku, meta) {
    // Method 1: Stealth HTTP (impit) — free, fast.
    // DataDome currently 403s every HTTP client here, so after a failure we stop trying for
    // a while instead of burning a proxy request per check; the probe re-runs periodically
    // so the free path comes straight back if the block is ever lifted.
    if (Date.now() >= this._stealthBlockedUntil) {
      try {
        const proxyUrl = getProxyUrl('residential');
        const html = await stealthGet(meta.url, {
          proxyUrl,
          maxRetries: 1,
          timeoutMs: 15000,
        });

        if (html && !this.isChallengePage(html)) {
          const data = this._parseProductHtml(html);
          if (data) {
            if (this._stealthBlockedUntil) logger.info('Pokemon Center: stealth path is working again');
            this._stealthBlockedUntil = 0;
            return { data, failReason: null };
          }
        }
        this._stealthBlockedUntil = Date.now() + 30 * 60 * 1000;
      } catch {
        this._stealthBlockedUntil = Date.now() + 30 * 60 * 1000;
      }
    }

    // Method 2: Bright Data Web Unlocker.
    //
    // Placed ABOVE ScraperAPI deliberately. Pokemon Center stacks DataDome and Imperva, and
    // ScraperAPI cannot get through either tier: measured 2026-09-06, it returns 500 after
    // ~55s at standard, premium and ultra_premium, with and without rendering, and its Async
    // Scraper spent 5.8 minutes retrying before returning a DataDome block page. Leaving it
    // first would burn ~55s per check to always fail. Bright Data returned real stock fields
    // on 5/5 with one retry, so it is the paid path that actually works here.
    //
    // Still second overall: the free stealth attempt above runs first, so a request that can
    // be served for nothing never reaches a billed provider.
    if (brightData.isConfigured()) {
      // meta carries {url, name} and no sku, so the label was always 'pc' and a failure
      // could not be traced back to a product. The sku is passed explicitly now.
      const { html, reason } = await brightData.unlock(meta.url, { label: sku, url: meta.url });
      // expect_element is documented as not improving on retry, and measured 6/6 persistent
      // on the same URLs across two networks. Park it on the FIRST occurrence: at 45-139s a
      // go, waiting for a second confirmation burns minutes of the checker for no new
      // information, and a run of same-template products can stall a whole batch.
      if (reason && /^expect_element/.test(reason)) this._parkNow(sku, reason);
      if (html) {
        // Parse FIRST. A page that yields real price and availability is a real page,
        // whatever scripts it happens to reference — that ordering is what stops a
        // vendor-name false positive from discarding a good response ever again.
        const data = this._parseProductHtml(html);
        if (data) return { data, failReason: null };
        if (this.isChallengePage(html)) return { data: null, failReason: FAILURE_REASONS.BOT_CHALLENGE };
        return { data: null, failReason: FAILURE_REASONS.NO_MARKERS };
      }
      // Fall through only when Bright Data itself could not deliver, so a genuine block is
      // still visible rather than silently swallowed.
      if (!html) return { data: null, failReason: FAILURE_REASONS.EMPTY_RESPONSE };
      return { data: null, failReason: FAILURE_REASONS.BOT_CHALLENGE };
    }

    // Method 3: protectedFetch (browser → ScraperAPI) — only when Bright Data is unavailable
    try {
      const html = await this.protectedFetch(meta.url, {
        timeoutMs: 30000,
        challengeDetector: (h) => this.isChallengePage(h),
        scraperOpts: { ultraPremium: true },
      });

      if (!html) {
        return { data: null, failReason: FAILURE_REASONS.EMPTY_RESPONSE };
      }
      if (this.isChallengePage(html)) {
        return { data: null, failReason: FAILURE_REASONS.BOT_CHALLENGE };
      }

      const data = this._parseProductHtml(html);
      if (data) return { data, failReason: null };

      return { data: null, failReason: FAILURE_REASONS.NO_MARKERS };
    } catch (err) {
      const reason = classifyError(err);
      return { data: null, failReason: reason };
    }
  }

  _parseProductHtml(html) {
    // Try JSON-LD first (most reliable)
    const jsonLd = this.parseJsonLd(html);
    if (jsonLd) return jsonLd;

    // Try __NEXT_DATA__ embedded JSON
    const nextData = this.parseNextData(html);
    if (nextData) return nextData;

    // Fallback: HTML text markers
    return this.parseHtmlMarkers(html);
  }

  parseJsonLd(html) {
    let idx = 0;
    while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
      const start = html.indexOf('>', idx) + 1;
      const end = html.indexOf('</script>', start);
      if (end === -1) break;
      try {
        const json = JSON.parse(html.substring(start, end).trim());
        if (json['@type'] === 'Product') {
          const { inStock, price } = readOffers(json.offers);
          return {
            inStock,
            price,
            // PC ships `image` as an ARRAY of five-plus gallery URLs. Stored raw it reaches
            // embeds.setThumbnail(), which throws on an array and loses the alert permanently
            // (see the note there). Take the first URL — it is the primary product shot.
            image: Array.isArray(json.image) ? (json.image[0] || '') : (json.image || ''),
          };
        }
      } catch (err) { logger.debug(`Pokemon Center: malformed JSON-LD: ${err.message}`); }
      idx = end;
    }
    return null;
  }

  parseNextData(html) {
    const match = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
    if (!match) return null;
    try {
      const data = JSON.parse(match[1]);
      const pp = data?.props?.pageProps;
      if (!pp) return null;
      const product = pp.product || pp.productData || pp.initialData?.product;
      if (!product) return null;

      const inStock = product.inStock ?? product.isAvailable ?? (product.availability === 'InStock') ?? null;
      const price = product.price?.amount || product.price || product.offers?.[0]?.price || null;
      const image = product.image?.url || product.images?.[0]?.url || '';

      if (inStock === null) return null;
      return { inStock: !!inStock, price: typeof price === 'number' ? price : normalizePrice(String(price || '')), image };
    } catch (err) {
      logger.debug(`Pokemon Center: __NEXT_DATA__ parse failed: ${err.message}`);
      return null;
    }
  }

  parseHtmlMarkers(html) {
    const lower = html.toLowerCase();
    const outOfStock = lower.includes('out of stock') || lower.includes('sold out') ||
      lower.includes('currently unavailable') || lower.includes('"outofstock"');
    const hasAddToCart = lower.includes('add to cart') || lower.includes('add to bag');

    if (!outOfStock && !hasAddToCart) return null;

    // Deliberately NO price from this fallback path. It used to take the first "$" anywhere in
    // the page, which is as likely to be a shipping threshold, a promo banner or a related
    // product as the item's own price — the same defect that had Amazon attributing a
    // neighbour's price to an unpriced listing and firing false restocks off it. This runs
    // only when the structured __NEXT_DATA__ parse has already failed, so there is no reliable
    // anchor left, and a wrong price is worse than none: it pollutes price history and can
    // trigger a spurious price-drop alert. Availability is still worth reporting.
    return {
      inStock: outOfStock ? false : true,
      price: null,
      image: '',
    };
  }
}

module.exports = PokemonCenterAdapter;
// Exported for tests: the stock verdict decides what reaches a paid channel, and the function
// that reads the DOM around it cannot be tested at all (page.evaluate serialises it).
module.exports.pcVerdict = pcVerdict;
module.exports.pcNameFromSlug = pcNameFromSlug;
// Exported for tests too: which URL the sweep asks for decides how many requests the store sees.
module.exports.pcCategoryUrl = pcCategoryUrl;
module.exports.PC_PAGE_SIZE = PC_PAGE_SIZE;
module.exports.resolvePageSize = resolvePageSize;
