const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const state = require('../core/state');
const { sleep, hashSku } = require('../utils/helpers');
const scraperApi = require('../utils/scraper-api');
const { curlGet } = require('../utils/curl-get');

const DEEP_CRAWL_INTERVAL_DEFAULT = 5 * 60 * 1000;
const DEEP_CRAWL_INTERVAL_FLOOR = 60 * 1000;
const CONCURRENCY = 4;

// A single crawl may never delete more than this share of the known catalogue. EB Games has
// ~250 tracked products; a real delisting trickles, a bad read arrives all at once.
const MAX_DROP_SHARE = 0.2;

// Odoo eCommerce category routes — only the games the client tracks.
// fastPages: pages fetched every poll (newest-first + recently-modified); the deep crawl covers the rest.
const SOURCES = [
  { key: 'pokemon',  path: '/shop/category/trading-cards-pokemon-204', fastPages: 2 },
  { key: 'onepiece', path: '/shop/category/trading-cards-one-piece-208', fastPages: 1 },
];

const SORT_NEWEST = 'create_date desc';
const SORT_MODIFIED = 'write_date desc';

// Cloudflare challenges impit here unless cert verification is off (it changes the TLS ClientHello)
const STEALTH_OPTS = { ignoreTlsErrors: true, timeoutMs: 12000 };

// Paid fallback pacing.
//
// Cloudflare began refusing every free route into ebgames.ca — direct, ISP and residential all
// answer 403 in under 200ms — and the adapter reported "found 0 products" on every poll while
// looking healthy, because a poll that returns nothing without throwing is not an error.
// Measured 2026-09-08: ScraperAPI standard returns the real listing (927KB, 27 product links,
// no challenge) for 1 credit, so the store is recoverable, just not for free.
//
// The floor is on the PAID path only. The free path keeps trying at the adapter's own interval,
// so the moment Cloudflare relents EB Games returns to full speed at zero cost with no
// intervention. A burst window lets one poll's pages through together — gating per request
// would starve pages 2 and 3 of every cycle — while still allowing only one burst per floor.
const PAID_FLOOR_MS = Number(process.env.EBGAMES_PAID_FLOOR_MS) || 30000;
const PAID_BURST_MS = Number(process.env.EBGAMES_PAID_BURST_MS) || 15000;
// A time window alone does not bound cost. Measured after shipping the floor: 56,640 credits a
// day, 4.4x the estimate, because the 5-minute deep crawl's ~30 pages all rode through a single
// open window — the floor limited how OFTEN a burst starts, never how much went through one.
// Capping calls per burst is what actually bounds the spend; the deep crawl simply completes
// across several bursts instead of one, which costs it nothing that matters.
const PAID_MAX_PER_BURST = Number(process.env.EBGAMES_PAID_MAX_PER_BURST) || 4;
// The deep crawl needs a whole catalogue in one pass, so a four-call burst starves it: capping
// it there pinned coverage at 67 of 801 products, because every crawl re-fetched the same first
// four pages and never reached the rest. It gets its own grant per crawl instead — bounded, so
// it still cannot run away, but large enough to finish. Cost is this number times the number of
// crawls per day, which is what deepCrawlIntervalMs controls.
const PAID_MAX_PER_CRAWL = Number(process.env.EBGAMES_PAID_MAX_PER_CRAWL) || 40;

// Cloudflare rate-limits bursts (~90 requests in 7s got 429s, 2 req/s still tripped it occasionally)
const MIN_SPACING_DEFAULT = 750;
const MIN_SPACING_FLOOR = 400;
const RATE_LIMIT_COOLDOWN_MS = 15000;

const CARD_RE = /<form role="article"[^>]*\boe_product_cart\b[^>]*>[\s\S]*?<\/form>/g;

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function isChallenge(html) {
  return !html || html.length < 2000
    || /<title>Just a moment/i.test(html) || html.includes('_cf_chl_opt') || html.includes('cf-browser-verification');
}

function maxPage(html) {
  let max = 1;
  for (const m of html.matchAll(/\/page\/(\d+)/g)) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

function parseCard(card, baseUrl, game) {
  const link = card.match(/href="\/shop\/(?:[^"/]+\/)?(\d+)-([^"]*?)-(\d+)"/);
  if (!link) return null;
  const [, sku, slug, templateId] = link;

  const label = card.match(/aria-label="([^"]*)"/);
  const name = label ? decodeEntities(label[1]).replace(/\s+/g, ' ').trim() : '';
  if (!name) return null;

  const priceMatch = card.match(/condition_prices\[&#39;new&#39;\][^>]*>[^<]*<span class="oe_currency_value">([\d.,]+)/)
    || card.match(/oe_currency_value">([\d.,]+)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

  const badges = [...card.matchAll(/class="s_badge[^"]*"[^>]*>(?:\s*<i[^>]*><\/i>)?\s*([^<]+)</g)].map(m => m[1].trim());
  const badgeInStock = badges.some(b => /in stock/i.test(b));
  const canAddToCart = /name="product_id"/.test(card);
  const productId = card.match(/name="product_id"[^>]*value="(\d+)"/);
  const img = card.match(/<img src="([^"]+)"/);

  return {
    sku,
    name,
    price,
    currency: 'CAD',
    url: `${baseUrl}/shop/${sku}-${slug}-${templateId}`,
    image: img ? `${baseUrl}${decodeEntities(img[1])}` : '',
    inStock: badgeInStock || canAddToCart,
    canAddToCart,
    isPreorderable: /pre-?order/i.test(name),
    seller: 'EB Games',
    shipsToHome: true,
    templateId,
    _productId: productId ? productId[1] : null,
    game,
  };
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

class EBGamesAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.watchlist = new Set(config.watchlist || []);
    this._knownProducts = new Map(); // sku → classified product (full catalog from deep crawl)
    this._pageCounts = new Map();    // source key → page count from last deep crawl
    this._lastDeepCrawlAt = 0;
    this._deepCrawlRunning = false;
    this._nextSlot = 0;
    this._cooldownUntil = 0;
    this._lastPaidAt = 0;
    this._paidWindowUntil = 0;
    this._paidFetches = 0;
    this._paidInBurst = 0;
    this._crawlPaidRemaining = 0;
    this._curlReported = false;
    this._seeded = false;
    this._deriveTiming();
  }

  _deriveTiming() {
    this.deepCrawlIntervalMs = this.timingValue('deepCrawlIntervalMs', DEEP_CRAWL_INTERVAL_DEFAULT, DEEP_CRAWL_INTERVAL_FLOOR);
    this.minSpacingMs = this.timingValue('minSpacingMs', MIN_SPACING_DEFAULT, MIN_SPACING_FLOOR);
  }

  // Global spacer shared by every EB Games request (crawl, fast poll, watchlist)
  async _throttle() {
    const now = Date.now();
    const slot = Math.max(now, this._nextSlot, this._cooldownUntil);
    this._nextSlot = slot + this.minSpacingMs;
    if (slot > now) await sleep(slot - now);
  }

  async fetchProducts() {
    if (this._knownProducts.size === 0) {
      // First run seeds the catalog. It is backgrounded so a slow crawl can't blow the
      // scheduler's adapter timeout; the poll returns empty and the next one picks up
      // the seeded catalog. _seedRedis keeps that first landing from firing NEW_SKU.
      if (!this._deepCrawlRunning) {
        this._deepCrawl().catch(err => logger.warn(`EB Games: seed crawl error: ${err.message}`));
      }
      return {};
    } else {
      if (!this._deepCrawlRunning && Date.now() - this._lastDeepCrawlAt >= this.deepCrawlIntervalMs) {
        this._deepCrawl().catch(err => logger.warn(`EB Games: deep crawl error: ${err.message}`));
      }
      await this._fastPoll();
    }
    return Object.fromEntries(this._knownProducts);
  }

  _listingUrl(source, page, sort) {
    const params = new URLSearchParams({ order: sort });
    return `${this.url}${source.path}${page > 1 ? `/page/${page}` : ''}?${params}`;
  }

  /**
   * May this fetch use the paid route?
   *
   * Opens a short window on the first paid call so the rest of that poll's pages come with it,
   * then closes until the floor has elapsed. Without the window a 20s floor would deliver one
   * page per 20s and never assemble a complete listing.
   */
  _paidAllowed() {
    // A crawl in progress spends from its own grant first: it is refreshing the whole
    // catalogue, not racing a drop, and the fast poll's burst cap is sized for 3 pages.
    if (this._crawlPaidRemaining > 0) { this._crawlPaidRemaining -= 1; return true; }
    const now = Date.now();
    if (now < this._paidWindowUntil) {
      if (this._paidInBurst >= PAID_MAX_PER_BURST) return false;
      this._paidInBurst += 1;
      return true;
    }
    if (now - this._lastPaidAt < PAID_FLOOR_MS) return false;
    this._lastPaidAt = now;
    this._paidWindowUntil = now + PAID_BURST_MS;
    this._paidInBurst = 1;
    return true;
  }

  async _fetchListing(url) {
    await this._throttle();

    // curl first, because it is the only client Cloudflare accepts here — and it is free.
    //
    // Measured from one address within minutes: impit with a Chrome fingerprint 403,
    // node-fetch 403, undici 403, curl 200 with the full 926KB listing in ~1s. Spoofing Chrome
    // is actively worse than not spoofing anything on this host. Getting this right takes EB
    // Games off the paid route entirely, which was running at ~14,400 credits a day.
    //
    // Any failure falls through to the routes below, so this can only add coverage.
    try {
      const res = await curlGet(url, { timeoutMs: 20000 });
      if (res && res.status === 200 && !isChallenge(res.body)) {
        // Say which strategy actually served the page, once. Whether curl works from this host
        // decides whether EB Games is free or costs ~14,400 credits a day, and without this the
        // only symptom is a credit counter moving for reasons nobody can see.
        if (!this._curlReported) {
          this._curlReported = true;
          logger.info('EB Games: curl works from this host — listings are free, no paid fallback needed');
        }
        return res.body;
      }
      if (!this._curlReported) {
        this._curlReported = true;
        const why = !res ? 'curl binary unavailable'
          : res.status === 0 ? `transfer failed: ${res.error || 'unknown'}`
            : `HTTP ${res.status}`;
        logger.warn(`EB Games: curl did NOT work here (${why}) — falling back to the paid route`);
      }
    } catch (err) {
      if (!this._curlReported) {
        this._curlReported = true;
        logger.warn(`EB Games: curl threw (${err.message}) — falling back to the paid route`);
      }
    }

    let stealthErr = null;
    try {
      const html = await this.stealthFetch(url, { ...STEALTH_OPTS, maxRetries: 2, retryDelayMs: 1500 });
      if (isChallenge(html)) throw new Error('Cloudflare challenge');
      return html;
    } catch (err) {
      if (err.message.includes('429')) this._cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      stealthErr = err;
    }

    // Free route refused. Pay for it, but only as often as the floor allows.
    if (!scraperApi.isConfigured()) throw stealthErr;
    if (!this._paidAllowed()) {
      // OUR choice, not the retailer's. Marked so the poll can tell the two apart: the free
      // route is blocked and we have decided not to buy this page yet.
      const skip = new Error(`Paid floor: not buying ${url} yet`);
      skip.selfSkip = true;
      throw skip;
    }
    const html = await scraperApi.scraperFetch(url, {
      render: false, premium: false, ultraPremium: false,
      retailerId: this.id, minIntervalMs: 0, timeoutMs: 45000,
    });
    // null means rate-limited or budget-paused upstream, not a page — surface the original
    // failure so health sees the free route's error rather than a silent empty result.
    if (!html || isChallenge(html)) throw stealthErr;
    this._paidFetches = (this._paidFetches || 0) + 1;
    return html;
  }

  // Runs listing jobs through the pool; whatever failed gets one more attempt after the rest finish
  async _fetchJobs(jobs) {
    const results = await runPool(jobs.map(j => () => this._fetchListing(j.url)), CONCURRENCY);
    const retryIdx = results.map((r, i) => (r.ok ? -1 : i)).filter(i => i >= 0);
    if (retryIdx.length > 0) {
      const second = await runPool(retryIdx.map(i => () => this._fetchListing(jobs[i].url)), CONCURRENCY);
      retryIdx.forEach((idx, k) => { results[idx] = second[k]; });
    }
    return results;
  }

  /** @returns {number} product cards actually parsed out of this page */
  _ingest(html, source, into) {
    let added = 0;
    for (const m of html.matchAll(CARD_RE)) {
      const parsed = parseCard(m[0], this.url, source.key);
      if (!parsed) continue;
      added++;
      if (!into.has(parsed.sku)) into.set(parsed.sku, this.classify(parsed));
    }
    return added;
  }

  // Newer observation wins — a background crawl must not overwrite a fresher fast-poll result
  _merge(fresh, replace) {
    const target = replace ? new Map(fresh) : this._knownProducts;
    const previous = this._knownProducts;
    for (const [sku, old] of previous) {
      const next = fresh.get(sku);
      if (!next) { if (!replace) target.set(sku, old); continue; }
      if (old.lastSeen > next.lastSeen) target.set(sku, old);
      else target.set(sku, next);
    }
    for (const [sku, next] of fresh) if (!previous.has(sku)) target.set(sku, next);
    this._knownProducts = target;
  }

  // Every poll: newest-first + recently-modified pages of the hot categories.
  // Categories small enough to fit in fastPages are covered completely each poll.
  async _fastPoll() {
    const start = Date.now();
    const jobs = [];
    for (const src of SOURCES) {
      if (!src.fastPages) continue;
      const total = this._pageCounts.get(src.key) || src.fastPages;
      if (total <= src.fastPages) {
        for (let p = 1; p <= total; p++) jobs.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
      } else {
        for (let p = 1; p <= src.fastPages; p++) {
          jobs.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
          jobs.push({ src, url: this._listingUrl(src, p, SORT_MODIFIED) });
        }
      }
    }

    const results = await this._fetchJobs(jobs);
    const seen = new Map();
    let ok = 0;
    results.forEach((r, i) => {
      if (!r.ok) {
        if (r.error && r.error.selfSkip) logger.debug(`EB Games: ${r.error.message}`);
        else logger.warn(`EB Games: fast fetch failed ${jobs[i].url}: ${r.error.message}`);
        return;
      }
      ok++;
      this._ingest(r.value, jobs[i].src, seen);
    });
    if (ok === 0) {
      // Every page refused BY US is not a retailer failure and must not count as a poll error.
      // The fast poll runs every 5s while the paid floor allows a purchase every 30s, so five
      // polls in six legitimately buy nothing. Counting those as errors gave EB Games 33
      // consecutive failures and a degraded health status while it was working correctly — and
      // enough of them would trip the circuit breaker, whose recovery probes would hit the same
      // floor. That exact loop kept the Shopify shops down for hours on 2026-09-05.
      const allSelfSkip = results.every((r) => !r.ok && r.error && r.error.selfSkip);
      if (allSelfSkip) {
        logger.debug('EB Games: fast poll skipped — paid floor not elapsed, free route blocked');
        return;
      }
      throw new Error('all fast-poll pages failed (Cloudflare block?)');
    }

    const added = [...seen.keys()].filter(sku => !this._knownProducts.has(sku)).length;
    this._merge(seen, false);
    const inStock = [...seen.values()].filter(p => p.inStock).length;
    logger.info(`EB Games: FAST — ${ok}/${jobs.length} pages, ${seen.size} products (${inStock} in stock${added ? `, ${added} new` : ''}), ${Date.now() - start}ms`);
  }

  // Every 5 min: every page of every category (page size is locked to 10 server-side).
  async _deepCrawl() {
    // Fresh grant per crawl. Set here rather than in the constructor so a crawl that dies
    // partway cannot leave credit behind for the fast poll to spend.
    this._crawlPaidRemaining = PAID_MAX_PER_CRAWL;
    this._deepCrawlRunning = true;
    const start = Date.now();
    try {
      const fresh = new Map();
      let fetched = 0;
      let failed = 0;
      // A page can return HTTP 200 and still contain no product cards — Odoo pagination
      // drifts, and a re-render can briefly omit the grid. That is NOT evidence the products
      // are gone, but it used to be treated as exactly that.
      let empty = 0;

      const firstJobs = SOURCES.map(src => ({ src, url: this._listingUrl(src, 1, SORT_NEWEST) }));
      const firstPages = await this._fetchJobs(firstJobs);
      const remaining = [];
      firstPages.forEach((r, i) => {
        const { src } = firstJobs[i];
        if (!r.ok) { failed++; logger.warn(`EB Games: ${src.key} page 1 failed: ${r.error.message}`); return; }
        fetched++;
        const pages = maxPage(r.value);
        this._pageCounts.set(src.key, pages);
        if (this._ingest(r.value, src, fresh) === 0) empty++;
        for (let p = 2; p <= pages; p++) remaining.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
      });

      const rest = await this._fetchJobs(remaining);
      rest.forEach((r, i) => {
        if (!r.ok) { failed++; return; }
        fetched++;
        if (this._ingest(r.value, remaining[i].src, fresh) === 0) empty++;
      });

      if (fetched === 0) throw new Error('all listing pages failed (Cloudflare block?)');

      // Only a complete, plausible crawl may drop delisted products.
      //
      // "Complete" used to mean every page returned HTTP 200. That let a page which loaded
      // fine but parsed zero cards count as an authoritative "these products no longer
      // exist": they were dropped from _knownProducts, poll-adapter's stale cleanup marked
      // them out of stock, and the next crawl brought them all back at once. That is the
      // source of the bursts — the alert limiter recorded "21 alerts in 0s", one poll
      // flipping the catalogue, not products restocking every 24 minutes.
      //
      // The share guard is the second line of defence. Even a technically clean crawl that
      // wants to delete most of the catalogue is far more likely to be a bad read than a
      // retailer delisting its entire Pokemon range in five minutes.
      const knownBefore = this._knownProducts.size;
      const wouldDrop = knownBefore
        ? [...this._knownProducts.keys()].filter(sku => !fresh.has(sku)).length / knownBefore
        : 0;
      const trustworthy = failed === 0 && empty === 0 && wouldDrop <= MAX_DROP_SHARE;
      if (!trustworthy && knownBefore > 0 && (empty > 0 || wouldDrop > MAX_DROP_SHARE)) {
        logger.warn(`EB Games: not dropping products this crawl — ${empty} empty page(s), ` +
          `would have removed ${Math.round(wouldDrop * 100)}% of ${knownBefore}`);
      }
      this._merge(fresh, trustworthy);
      this._lastDeepCrawlAt = Date.now();
      if (!this._seeded) await this._seedRedis(failed === 0);

      const inStock = [...this._knownProducts.values()].filter(p => p.inStock).length;
      logger.info(`EB Games: DEEP — ${fetched} pages${failed ? ` (${failed} failed)` : ''}${empty ? ` (${empty} empty)` : ''}, ${this._knownProducts.size} products (${inStock} in stock), ${Date.now() - start}ms. Next in ${Math.round(this.deepCrawlIntervalMs / 60000)}min.`);
    } finally {
      this._deepCrawlRunning = false;
    }
  }

  // Until one complete crawl has been stored, write the catalog straight into Redis so products
  // a partial first crawl missed don't surface later as a NEW_SKU alert storm
  async _seedRedis(complete) {
    try {
      const existing = await state.getAllProducts(this.id);
      const missing = [...this._knownProducts.entries()].filter(([sku]) => !existing[sku]);
      if (missing.length > 0) {
        const pipeline = state.getRedis().pipeline();
        for (const [sku, product] of missing) {
          pipeline.set(`tcg:product:${hashSku(this.id, sku)}`, JSON.stringify(product), 'EX', 86400 * 7);
        }
        await pipeline.exec();
        logger.info(`EB Games: seeded ${missing.length} catalog products into Redis (no alerts)`);
      }
      if (complete) this._seeded = true;
    } catch (err) {
      logger.warn(`EB Games: Redis seed failed: ${err.message}`);
    }
  }

  /**
   * Watchlist fast-poll for a single SKU. Odoo only resolves /shop/{templateId}, so the SKU is
   * mapped through the crawled catalog, or looked up via search (which matches default_code).
   */
  async fetchProductPage(sku) {
    const id = String(sku);
    let templateId = this._knownProducts.get(id)?.templateId;
    if (!templateId) templateId = await this._lookupTemplateId(id);
    if (!templateId) {
      logger.warn(`EB Games: WATCHLIST ${id} — SKU not found on site`);
      return null;
    }

    const start = Date.now();
    await this._throttle();
    const html = await this.stealthFetch(`${this.url}/shop/${templateId}`, { ...STEALTH_OPTS, maxRetries: 1 });
    if (isChallenge(html)) throw new Error('Cloudflare challenge');

    const ld = this._productJsonLd(html);
    if (!ld) {
      logger.warn(`EB Games: WATCHLIST ${id} — no product JSON-LD on page`);
      return null;
    }

    const availability = ld.offers?.availability || '';
    const inStock = /InStock|PreOrder|LimitedAvailability/i.test(availability);
    const known = this._knownProducts.get(id) || {};
    const pageProductId = html.match(/name="product_id"[^>]*value="(\d+)"/);
    const product = this.classify({
      ...known,
      sku: id,
      name: ld.name || known.name || '',
      price: Number(ld.offers?.price) || known.price || 0,
      currency: 'CAD',
      url: ld.url || known.url || `${this.url}/shop/${templateId}`,
      image: ld.image || known.image || '',
      inStock,
      canAddToCart: inStock && html.includes('id="add_to_cart"'),
      isPreorderable: /PreOrder/i.test(availability) || /pre-?order/i.test(ld.name || ''),
      seller: 'EB Games',
      shipsToHome: true,
      templateId: String(templateId),
      _productId: pageProductId ? pageProductId[1] : known._productId || null,
      gtin: ld.gtin || known.gtin || null,
    });
    product._watchlist = true;
    this._knownProducts.set(id, product);
    logger.info(`EB Games: WATCHLIST ${id} — "${product.name}" | inStock=${inStock} | $${product.price} | ${Date.now() - start}ms`);
    return product;
  }

  async _lookupTemplateId(sku) {
    try {
      const html = await this._fetchListing(`${this.url}/shop?search=${encodeURIComponent(sku)}`);
      for (const m of html.matchAll(CARD_RE)) {
        const parsed = parseCard(m[0], this.url, 'other');
        if (parsed?.sku === sku) return parsed.templateId;
      }
    } catch (err) {
      logger.warn(`EB Games: SKU lookup failed for ${sku}: ${err.message}`);
    }
    return null;
  }

  _productJsonLd(html) {
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const data = JSON.parse(m[1]);
        const product = (Array.isArray(data) ? data : [data]).find(i => i['@type'] === 'Product');
        if (product) return product;
      } catch { /* not a product block */ }
    }
    return null;
  }
}

module.exports = EBGamesAdapter;
