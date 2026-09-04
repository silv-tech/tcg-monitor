const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const state = require('../core/state');
const { sleep, hashSku } = require('../utils/helpers');

const DEEP_CRAWL_INTERVAL_DEFAULT = 5 * 60 * 1000;
const DEEP_CRAWL_INTERVAL_FLOOR = 60 * 1000;
const CONCURRENCY = 4;

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

  async _fetchListing(url) {
    await this._throttle();
    try {
      const html = await this.stealthFetch(url, { ...STEALTH_OPTS, maxRetries: 2, retryDelayMs: 1500 });
      if (isChallenge(html)) throw new Error('Cloudflare challenge');
      return html;
    } catch (err) {
      if (err.message.includes('429')) this._cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      throw err;
    }
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

  _ingest(html, source, into) {
    for (const m of html.matchAll(CARD_RE)) {
      const parsed = parseCard(m[0], this.url, source.key);
      if (parsed && !into.has(parsed.sku)) into.set(parsed.sku, this.classify(parsed));
    }
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
      if (!r.ok) { logger.warn(`EB Games: fast fetch failed ${jobs[i].url}: ${r.error.message}`); return; }
      ok++;
      this._ingest(r.value, jobs[i].src, seen);
    });
    if (ok === 0) throw new Error('all fast-poll pages failed (Cloudflare block?)');

    const added = [...seen.keys()].filter(sku => !this._knownProducts.has(sku)).length;
    this._merge(seen, false);
    const inStock = [...seen.values()].filter(p => p.inStock).length;
    logger.info(`EB Games: FAST — ${ok}/${jobs.length} pages, ${seen.size} products (${inStock} in stock${added ? `, ${added} new` : ''}), ${Date.now() - start}ms`);
  }

  // Every 5 min: every page of every category (page size is locked to 10 server-side).
  async _deepCrawl() {
    this._deepCrawlRunning = true;
    const start = Date.now();
    try {
      const fresh = new Map();
      let fetched = 0;
      let failed = 0;

      const firstJobs = SOURCES.map(src => ({ src, url: this._listingUrl(src, 1, SORT_NEWEST) }));
      const firstPages = await this._fetchJobs(firstJobs);
      const remaining = [];
      firstPages.forEach((r, i) => {
        const { src } = firstJobs[i];
        if (!r.ok) { failed++; logger.warn(`EB Games: ${src.key} page 1 failed: ${r.error.message}`); return; }
        fetched++;
        const pages = maxPage(r.value);
        this._pageCounts.set(src.key, pages);
        this._ingest(r.value, src, fresh);
        for (let p = 2; p <= pages; p++) remaining.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
      });

      const rest = await this._fetchJobs(remaining);
      rest.forEach((r, i) => {
        if (!r.ok) { failed++; return; }
        fetched++;
        this._ingest(r.value, remaining[i].src, fresh);
      });

      if (fetched === 0) throw new Error('all listing pages failed (Cloudflare block?)');

      // Only a complete crawl may drop delisted products
      this._merge(fresh, failed === 0);
      this._lastDeepCrawlAt = Date.now();
      if (!this._seeded) await this._seedRedis(failed === 0);

      const inStock = [...this._knownProducts.values()].filter(p => p.inStock).length;
      logger.info(`EB Games: DEEP — ${fetched} pages${failed ? ` (${failed} failed)` : ''}, ${this._knownProducts.size} products (${inStock} in stock), ${Date.now() - start}ms. Next in ${Math.round(this.deepCrawlIntervalMs / 60000)}min.`);
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
