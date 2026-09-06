const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, sleep } = require('../utils/helpers');
const { FAILURE_REASONS, classifyError } = require('../core/failure-reasons');
const { stealthGet } = require('../utils/stealth-http');
const { getProxyUrl } = require('../core/proxy');
const state = require('../core/state');
const brightData = require('../utils/brightdata');

// One Redis key for the whole availability cache — written at most once per poll.
const PC_AVAILABILITY_KEY = 'tcg:pokemoncenter:availability';
const PC_UNFETCHABLE_KEY = 'tcg:pokemoncenter:unfetchable';

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

class PokemonCenterAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.sitemapUrl = 'https://www.pokemoncenter.com/sitemaps/products.xml';
    this.domain = 'www.pokemoncenter.com';
    this.seedUrl = 'https://www.pokemoncenter.com/en-ca/';

    // TCG sealed product keywords for filtering sitemap URLs
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
    this._watchlistCheckedAt = new Map();
    this._stealthBlockedUntil = 0;    // free-path circuit; retried occasionally in case the block lifts
    this._lastPaidCheckAt = 0;        // wall-clock gate on ScraperAPI spend (see _deriveTiming)

    // Track consecutive full-poll failures to avoid noisy error logging
    this._consecutiveFailures = 0;
    this._failStreak = new Map();     // sku -> consecutive total failures
    this._unfetchable = new Map();    // sku -> { until } while parked
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
    for (const sku of targets) {
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

  _noteCheckOutcome(sku, ok) {
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
      if (!raw) return;
      const saved = JSON.parse(raw);
      let restored = 0;
      for (const [sku, data] of Object.entries(saved)) {
        if (data && typeof data === 'object') { this.availabilityCache.set(sku, data); restored++; }
      }
      if (restored) logger.info(`Pokemon Center: restored ${restored} cached availability records`);
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

    for (const sku of this.watchlist) {
      if (!this.sitemapProducts.has(sku)) continue;
      if (now - (this._watchlistCheckedAt.get(sku) || 0) < this.watchlistIntervalMs) continue;
      targets.push(sku);
    }

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
        candidates.push([sku, this._rotationCheckedAt.get(sku) || 0]);
      }
      candidates.sort((a, b) => a[1] - b[1]); // never-checked (0) first, then stalest
      for (const [sku] of candidates) {
        if (targets.length >= this.checksPerPoll) break;
        targets.push(sku);
        this._rotationCheckedAt.set(sku, now);
        this._rotationSpentToday += 1;
      }
    }

    return targets.slice(0, Math.max(this.checksPerPoll, this.watchlist.size));
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
    const checked = 0;

    // Persist only when this poll actually learned something, so an idle poll costs no write.
    if (checked > 0) await this._saveAvailability();

    // Phase 3: Build full product list — use cached availability for all products
    // Keep last-known availability (even if stale) — prevents false OOS events
    for (const [sku, meta] of this.sitemapProducts) {
      const avail = this.availabilityCache.get(sku) || { inStock: false, price: null, image: '' };
      products[sku] = this.classify({
        sku,
        name: meta.name,
        price: avail.price,
        currency: 'CAD',
        url: meta.url,
        image: avail.image || '',
        inStock: avail.inStock,
        canAddToCart: avail.inStock,
        shipsToHome: true,
      });
    }

    this.reportFreshness(checked, batchSize);

    // Nothing new and nothing due: a quiet poll, not a failed one
    if (batchSize === 0) {
      this._consecutiveFailures = 0;
      // Selecting nothing to check is only "quiet" if something else can still produce an
      // alert. With an empty watchlist, nothing queued and no product known to be in stock,
      // this store cannot detect a restock at all — it logged exactly that, at info level,
      // every poll for days while appearing healthy. That is a configuration failure and it
      // must not read like a normal cycle.
      const detail = `${Object.keys(products).length} products, no checks due `
        + `(${this._newSkuQueue.length} queued, ${this.availabilityCache.size} with known stock)`;
      if (this.watchlist.size === 0 && this.availabilityCache.size === 0
          && this._rotationBudgetLeft() === 0) {
        logger.warn(`Pokemon Center: ${detail} — watchlist EMPTY and rotation budget spent, `
          + 'so no restock can be detected. Add SKUs to the watchlist or raise dailyRotationChecks.');
      } else {
        // Diagnostic: selecting zero targets with a populated sitemap and budget left should
        // be impossible, so print the inputs rather than guessing at it from the outside.
        logger.info(`Pokemon Center: ${detail} [sitemap=${this.sitemapProducts.size} `
          + `rotBudget=${this._rotationBudgetLeft()} spent=${this._rotationSpentToday} `
          + `checksPerPoll=${this.checksPerPoll} paidGate=${Math.max(0, this.paidCheckIntervalMs - (Date.now() - this._lastPaidCheckAt))}ms]`);
      }
      return products;
    }

    // Track consecutive failures
    if (checked === 0 && batchSize > 0) {
      this._consecutiveFailures++;
      if (this._consecutiveFailures <= 3 || this._consecutiveFailures % 10 === 0) {
        const failureSummary = Object.entries(failureCounts).map(([r, c]) => `${r}:${c}`).join(', ');
        logger.warn(`Pokemon Center: 0/${batchSize} checks succeeded (attempt ${this._consecutiveFailures}) — ${failureSummary}`);
      }
    } else {
      if (this._consecutiveFailures > 0) {
        logger.info(`Pokemon Center: recovered after ${this._consecutiveFailures} failed polls`);
      }
      this._consecutiveFailures = 0;
    }

    logger.info(`Pokemon Center: ${Object.keys(products).length} products (${checked}/${batchSize} checked, ${this._newSkuQueue.length} queued, ${this.availabilityCache.size} with known stock)`);
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
      const caUrl = url.replace(/\/en-[a-z]{2}\/product\//, '/en-ca/product/')
        .replace(/^(https?:\/\/[^/]+)\/product\//, '$1/en-ca/product/');

      newProducts.set(sku, { url: caUrl, name, rawUrl: url });
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
      logger.warn(`Pokemon Center: sitemap had ${urlMatches.length} URLs but 0 matched TCG keywords`);
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
      const html = await brightData.unlock(meta.url, { label: sku, url: meta.url });
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
          const availability = json.offers?.availability || '';
          return {
            inStock: availability.includes('InStock'),
            price: typeof json.offers?.price === 'number' ? json.offers.price : normalizePrice(String(json.offers?.price || '')),
            image: json.image || '',
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
