const logger = require('../monitoring/logger');
const { httpGet } = require('../utils/http');
const { stealthGet } = require('../utils/stealth-http');
const { getProxyUrl, getNextIspProxy, recordRequest, markProxyBlocked, markProxySuccess } = require('../core/proxy');
const productsConfig = require('../config/products.json');
const { classifyCategory, isTCGProduct } = require('../utils/helpers');
const scraperApi = require('../utils/scraper-api');
const state = require('../core/state');
const { isInScopeName, repairMojibake } = require('../utils/scope');

let browserModule;
try { browserModule = require('../utils/browser'); } catch { browserModule = null; }

let cookieSessionModule;
try { cookieSessionModule = require('../utils/cookie-session'); } catch { cookieSessionModule = null; }

class BaseAdapter {
  constructor(retailerConfig) {
    this.id = retailerConfig.id;
    this.name = retailerConfig.name;
    this.url = retailerConfig.url;
    this.intervalMs = retailerConfig.intervalMs;
    this.proxyTier = retailerConfig.proxyTier;
    this.color = retailerConfig.color;
    this.enabled = retailerConfig.enabled;
    this.maxProducts = retailerConfig.maxProducts || 500; // Configurable cap (#17)
    this.timing = retailerConfig.timing || {}; // Per-store cadence overrides (retailers.json / Redis)
    this._lastFreshness = null; // set via reportFreshness() by adapters that serve cached data
    // Opt out where a priceless catalogue is expected rather than a parser fault
    this.parseCanary = retailerConfig.parseCanary !== false;

    // Circuit breaker: stop wasting proxy bandwidth after consecutive browser failures
    this._browserFailCount = 0;
    this._browserCircuitOpen = false;
    this._browserCircuitOpenedAt = 0;
    this._BROWSER_FAIL_THRESHOLD = 3;       // Open circuit after 3 consecutive failures
    this._BROWSER_RETRY_INTERVAL = 600000;  // Try browser again every 10 minutes
  }

  /**
   * Read a per-store cadence knob, clamped to a floor the site's anti-bot tolerates.
   * Floors are enforced here rather than at the API so a value edited straight into
   * Redis still can't poll a retailer fast enough to get the proxy pool banned.
   */
  /**
   * Report how much of this poll was genuinely fresh data rather than cache.
   *
   * "Poll returned products" is not the same as "we learned anything". Pokemon Center
   * happily reported 500 products for a whole day while every availability check failed,
   * and Amazon reported success while serving an interstitial. Adapters that can tell the
   * difference say so here, and health treats a run of zero-fresh polls as a failure.
   *
   * @param {number} fresh - items with data actually retrieved this poll
   * @param {number} attempted - items we tried to retrieve; 0 means nothing was due (neutral)
   */
  reportFreshness(fresh, attempted) {
    this._lastFreshness = { fresh, attempted };
  }

  /** Merge new cadence values in and let the adapter re-derive — no redeploy needed. */
  applyTiming(timing) {
    this.timing = { ...this.timing, ...timing };
    this._deriveTiming();
  }

  /** Adapters that cache timing-derived values override this to recompute them. */
  _deriveTiming() {}

  timingValue(key, fallback, floorMs = 0) {
    const raw = Number(this.timing[key]);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    if (raw < floorMs) {
      logger.warn(`${this.name}: timing.${key}=${raw}ms is below the ${floorMs}ms floor — using ${floorMs}ms`);
      return floorMs;
    }
    return raw;
  }

  getProxy() {
    // Returns { url, proxyObj } — proxyObj is the pool entry for ISP proxies (null otherwise)
    if (this.proxyTier === 'isp') {
      const proxyObj = getNextIspProxy(this.id);
      return { url: proxyObj ? proxyObj.url : null, proxyObj };
    }
    return { url: getProxyUrl(this.proxyTier, this.id), proxyObj: null };
  }

  _isProxyBlock(err) {
    const msg = err.message || '';
    return msg.includes('403') || msg.includes('503') || msg.includes('Blocked')
      || msg.includes('blocked') || msg.includes('CAPTCHA') || msg.includes('captcha')
      || msg.includes('Access Denied') || msg.includes('connection refused')
      || msg.includes('ECONNREFUSED') || msg.includes('socket hang up');
  }

  async fetch(url, opts = {}) {
    const { url: proxyUrl, proxyObj } = this.getProxy();
    const stickyKey = this.proxyTier === 'isp' ? this.id : null;
    try {
      const result = await httpGet(url, { ...opts, proxyUrl, stickyKey });
      recordRequest(this.id, false, this.proxyTier);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (err) {
      recordRequest(this.id, true, this.proxyTier);
      if (proxyObj && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
  }

  async stealthFetch(url, opts = {}) {
    const { url: proxyUrl, proxyObj } = this.getProxy();
    try {
      const result = await stealthGet(url, { ...opts, proxyUrl });
      recordRequest(this.id, false, this.proxyTier, typeof result === 'string' ? result.length : 0);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (err) {
      recordRequest(this.id, true, this.proxyTier);
      if (proxyObj && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
  }

  async browserFetch(url, opts = {}) {
    if (!browserModule) {
      throw new Error('Browser fallback unavailable — install patchright');
    }
    const { url: proxyUrl, proxyObj } = this.getProxy();
    try {
      const result = await browserModule.browserFetch(url, { ...opts, proxyUrl });
      recordRequest(this.id, false, this.proxyTier);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (err) {
      recordRequest(this.id, true, this.proxyTier);
      if (proxyObj && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
  }

  /**
   * Protected fetch: tries browserFetch first (free), falls back to ScraperAPI (paid)
   * when a challenge page is detected. Pass a challengeDetector function to identify
   * bot protection pages in the returned HTML.
   *
   * @param {string} url - URL to fetch
   * @param {object} opts
   * @param {function} opts.challengeDetector - (html) => boolean, returns true if challenge page
   * @param {object} opts.scraperOpts - Options passed to scraperFetch (render, premium, country, etc.)
   * @param {number} opts.timeoutMs - Browser timeout
   * @param {string} opts.waitForSelector - CSS selector to wait for in browser
   * @returns {string} HTML content
   */
  async protectedFetch(url, opts = {}) {
    const { challengeDetector, scraperOpts = {}, noScraper = false, ...browserOpts } = opts;

    // Circuit breaker: skip browser if it's been consistently failing (saves proxy bandwidth)
    const now = Date.now();
    const browserSkipped = this._browserCircuitOpen &&
      (now - this._browserCircuitOpenedAt < this._BROWSER_RETRY_INTERVAL);

    if (browserSkipped) {
      logger.debug(`${this.name}: browser circuit open, skipping (retry in ${Math.round((this._BROWSER_RETRY_INTERVAL - (now - this._browserCircuitOpenedAt)) / 1000)}s)`);
    }

    // Step 1: Try browserFetch (free) — unless circuit breaker is open
    if (!browserSkipped) {
      // Reset circuit if retry interval has passed
      if (this._browserCircuitOpen) {
        logger.info(`${this.name}: browser circuit half-open, retrying browser...`);
        this._browserCircuitOpen = false;
      }

      try {
        const html = await this.browserFetch(url, browserOpts);
        if (html && (!challengeDetector || !challengeDetector(html))) {
          // Success — reset circuit breaker
          if (this._browserFailCount > 0) {
            logger.info(`${this.name}: browser succeeded after ${this._browserFailCount} failures, circuit closed`);
          }
          this._browserFailCount = 0;
          return html;
        }
        // Challenge detected — count as failure
        this._browserFailCount++;
        logger.debug(`${this.name}: browser returned challenge (fail ${this._browserFailCount}/${this._BROWSER_FAIL_THRESHOLD})`);
      } catch (err) {
        this._browserFailCount++;
        logger.debug(`${this.name}: browserFetch failed (${err.message}) (fail ${this._browserFailCount}/${this._BROWSER_FAIL_THRESHOLD})`);
      }

      // Open circuit if threshold reached
      if (this._browserFailCount >= this._BROWSER_FAIL_THRESHOLD && !this._browserCircuitOpen) {
        this._browserCircuitOpen = true;
        this._browserCircuitOpenedAt = now;
        logger.warn(`${this.name}: browser circuit OPEN — skipping browser for ${this._BROWSER_RETRY_INTERVAL / 60000}min to save proxy bandwidth`);
      }
    }

    // Step 2: Fall back to ScraperAPI (paid)
    if (noScraper || !scraperApi.isConfigured()) {
      return null; // No ScraperAPI — return null so adapter can handle gracefully
    }

    return scraperApi.scraperFetch(url, {
      render: true,
      premium: true,
      country: 'us',
      ...scraperOpts,
      retailerId: this.id,
    });
  }

  /**
   * Cookie-assisted stealth fetch: uses Playwright once to solve JS challenges,
   * caches cookies for 15 min, then uses impit + cookies for fast HTTP polling.
   * Falls back to full browser rendering if cookie approach fails.
   */
  async cookieFetch(url, opts = {}) {
    const { domain, seedUrl, challengeDetector, timeoutMs = 25000, waitForSelector } = opts;

    if (!cookieSessionModule) {
      throw new Error('Cookie session module unavailable');
    }

    const { url: proxyUrl, proxyObj } = this.getProxy();

    // Step 1: Try impit + cached/fresh session cookies
    try {
      const cookieString = await cookieSessionModule.getSessionCookies(domain, seedUrl, { proxyUrl });

      const result = await stealthGet(url, {
        proxyUrl,
        timeoutMs,
        maxRetries: 1,
        headers: { 'Cookie': cookieString },
      });

      // Check if we still got a challenge page
      if (challengeDetector && challengeDetector(result)) {
        logger.info(`${this.name}: cookies expired, refreshing session...`);
        cookieSessionModule.invalidateSession(domain);

        // Retry with fresh cookies
        const freshCookies = await cookieSessionModule.getSessionCookies(domain, seedUrl, {
          proxyUrl,
          forceRefresh: true,
        });

        const retryResult = await stealthGet(url, {
          proxyUrl,
          timeoutMs,
          maxRetries: 1,
          headers: { 'Cookie': freshCookies },
        });

        if (challengeDetector && challengeDetector(retryResult)) {
          throw new Error('Challenge persists after cookie refresh');
        }

        recordRequest(this.id, false, this.proxyTier);
        if (proxyObj) markProxySuccess(proxyObj);
        return retryResult;
      }

      recordRequest(this.id, false, this.proxyTier);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (cookieErr) {
      logger.info(`${this.name}: cookie fetch failed (${cookieErr.message}), trying full browser...`);

      // Step 2: Full browser fallback — renders the whole page with Playwright
      try {
        const html = await cookieSessionModule.browserFetchWithCookies(url, {
          proxyUrl,
          timeoutMs: 30000,
          waitForSelector,
          seedUrl,
        });

        recordRequest(this.id, false, this.proxyTier);
        if (proxyObj) markProxySuccess(proxyObj);
        return html;
      } catch (browserErr) {
        recordRequest(this.id, true, this.proxyTier);
        if (proxyObj && this._isProxyBlock(browserErr)) markProxyBlocked(proxyObj);
        throw new Error(`${this.name}: all fetch methods failed — cookie: ${cookieErr.message}, browser: ${browserErr.message}`);
      }
    }
  }

  /**
   * Delete persisted products that the shared scope test rejects.
   *
   * Filtering discovery is not enough on its own: products written by earlier builds survive
   * restarts and redeploys, and a cached entry that is re-checked every poll has its lastSeen
   * refreshed, so an "unseen for 24h" prune can never reach it. Amazon carried 159 such rows
   * out of 371; Walmart carried 190 out of 360 and alerted on 49 of them.
   *
   * Deliberately conservative, because wrongly deleting a catalogue would re-fire NEW_SKU for
   * every product on rediscovery — the exact flood this cleans up:
   *   - only entries that HAVE a name and fail the test are removed; a nameless or
   *     half-written entry is left alone rather than guessed at
   *   - it aborts if nearly everything fails, or if too little would be left standing
   *
   * The abort guards a total regression rather than a large cleanup. A first filter applied
   * to a catalogue that never had one legitimately removes a lot: Walmart's real share is 53%.
   */
  async _purgeOutOfScopeState(opts = {}) {
    const { maxShare = 0.9, minKept = 25 } = opts;
    const all = await state.getAllProducts(this.id);
    const entries = Object.entries(all || {});
    if (entries.length === 0) return { purged: 0, kept: 0, repaired: 0, aborted: false };

    // A watchlist SKU is a hand-picked product; no name heuristic gets to delete it.
    const watched = this.watchlist instanceof Set ? this.watchlist : new Set();
    const doomed = entries.filter(([sku, p]) =>
      p && p.name && !watched.has(String(sku)) && !p._watchlist && !isInScopeName(p.name));

    // Repair runs first and unconditionally. It used to sit after the purge, so once a
    // catalogue was clean the early return below skipped it forever — which is precisely the
    // state both retailers reached, leaving two corrupted Walmart names in place.
    const repaired = await this._repairStoredNames(entries, new Set(doomed.map(([sku]) => sku)));

    if (doomed.length === 0) return { purged: 0, kept: entries.length, repaired, aborted: false };

    const kept = entries.length - doomed.length;
    const share = doomed.length / entries.length;
    if (share > maxShare || kept < minKept) {
      logger.error(`${this.name}: refusing to purge ${doomed.length}/${entries.length} products ` +
        `(${Math.round(share * 100)}%, ${kept} would remain) — the scope test looks wrong, not the data`);
      return { purged: 0, kept: entries.length, repaired, aborted: true };
    }

    for (const [sku, p] of doomed) {
      await state.deleteProduct(this.id, sku).catch(err =>
        logger.warn(`${this.name}: failed to purge ${sku}: ${err.message}`));
      logger.info(`${this.name}: purged out-of-scope product ${sku} — ${String(p.name).slice(0, 70)}`);
    }
    logger.warn(`${this.name}: purged ${doomed.length} out-of-scope products from state (${kept} kept)`);
    return { purged: doomed.length, kept, repaired, aborted: false };
  }

  /**
   * Rewrite stored names that are mojibake.
   *
   * Repairing at read time keeps a corrupted row IN scope, which is what stopped two real
   * Walmart products being deleted — but it leaves the corruption in Redis. Those rows are
   * only rewritten when a poll happens to return them again, and a product that has dropped
   * out of the current search results never does. Two Walmart rows sat corrupted for exactly
   * that reason, and either would have gone out as "PokÃ©mon ... Shieldâ€”Evolving Skies" in
   * a Discord embed the moment it restocked. A wrong value in an alert is worse than a
   * missing one, so the name is fixed in place rather than only on the way past.
   */
  async _repairStoredNames(entries, skip = new Set()) {
    let fixed = 0;
    for (const [sku, p] of entries) {
      if (skip.has(sku) || !p || !p.name) continue;
      const repaired = repairMojibake(p.name);
      if (repaired === p.name) continue;
      await state.setProduct(this.id, sku, { ...p, name: repaired }).catch(err =>
        logger.warn(`${this.name}: failed to repair ${sku}: ${err.message}`));
      logger.info(`${this.name}: repaired stored name ${sku} — ${repaired.slice(0, 70)}`);
      fixed++;
    }
    if (fixed > 0) logger.warn(`${this.name}: repaired ${fixed} mojibake product name(s) in state`);
    return fixed;
  }

  classify(product) {
    product.category = classifyCategory(product.name, productsConfig.categories);
    product.isTCG = isTCGProduct(product.name);
    product.retailer = this.name;
    product.retailerId = this.id;
    product.lastSeen = Date.now();
    if (product.isPreorderable === undefined) product.isPreorderable = false;
    return product;
  }

  async fetchProducts() {
    throw new Error(`${this.id}: fetchProducts() not implemented`);
  }

  async run() {
    logger.info(`Polling ${this.name}...`);
    const start = Date.now();
    try {
      const products = await this.fetchProducts();
      // Product cap (#17) — prevent runaway adapters from consuming too much memory/Redis.
      // Sorted so the kept subset is the SAME set every poll: with insertion order the
      // retained 500 rotated, which re-fired NEW_SKU for old products and left a 7-day
      // Redis key behind for every product that ever cycled through.
      const keys = Object.keys(products).sort();
      if (keys.length > this.maxProducts) {
        logger.warn(`${this.name}: ${keys.length} products exceeds cap of ${this.maxProducts}, truncating`);
        for (const key of keys.slice(this.maxProducts)) {
          delete products[key];
        }
      }
      const elapsed = Date.now() - start;
      logger.info(`${this.name}: found ${Object.keys(products).length} products in ${elapsed}ms`);
      return products;
    } catch (err) {
      const elapsed = Date.now() - start;
      logger.error(`${this.name}: poll failed in ${elapsed}ms`, { error: err.message });
      throw err;
    }
  }
}

module.exports = BaseAdapter;
