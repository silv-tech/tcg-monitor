const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, sleep } = require('../utils/helpers');
const { FAILURE_REASONS, classifyError } = require('../core/failure-reasons');
const { stealthGet } = require('../utils/stealth-http');
const { getProxyUrl } = require('../core/proxy');

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
    this._newSkuQueue = [];           // newly listed skus awaiting a paid check
    this._seededSkus = false;         // first scan seeds silently — no flood after a restart
    this._watchlistCheckedAt = new Map();
    this._stealthBlockedUntil = 0;    // free-path circuit; retried occasionally in case the block lifts
    this._lastPaidCheckAt = 0;        // wall-clock gate on ScraperAPI spend (see _deriveTiming)

    // Track consecutive full-poll failures to avoid noisy error logging
    this._consecutiveFailures = 0;
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

  /** Products the paid checker should spend credits on this poll. */
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

    return targets.slice(0, Math.max(this.checksPerPoll, this.watchlist.size));
  }

  isChallengePage(html) {
    if (!html || html.length < 500) return true; // Too short = challenge or error
    return html.includes('Pardon Our Interruption') ||
      html.includes('distil_referrer') ||
      html.includes('Incapsula') ||
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

    // Phase 2: paid availability checks, only for newly listed and watchlisted products, and
    // only when the paid-check clock says so — the free sitemap phase above runs far more often.
    const paidDue = Date.now() - this._lastPaidCheckAt >= this.paidCheckIntervalMs;
    const targets = paidDue ? this._selectCheckTargets() : [];
    if (targets.length > 0) this._lastPaidCheckAt = Date.now();
    const batchSize = targets.length;

    let checked = 0;
    const failureCounts = {};
    for (let i = 0; i < batchSize; i++) {
      const sku = targets[i];
      const meta = this.sitemapProducts.get(sku);
      if (!meta) continue;
      if (this.watchlist.has(sku)) this._watchlistCheckedAt.set(sku, Date.now());
      try {
        const { data, failReason } = await this.checkProductAvailability(sku, meta);
        if (data) {
          data.checkedAt = Date.now();
          this.availabilityCache.set(sku, data);
          checked++;
        } else if (failReason) {
          failureCounts[failReason] = (failureCounts[failReason] || 0) + 1;
        }
      } catch (err) {
        const reason = classifyError(err);
        failureCounts[reason] = (failureCounts[reason] || 0) + 1;
      }
      // Small delay between checks to avoid triggering rate limits
      if (i < batchSize - 1) await sleep(500 + Math.floor(Math.random() * 1000));
    }

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
      logger.info(`Pokemon Center: ${Object.keys(products).length} products, no checks due (${this._newSkuQueue.length} queued, ${this.availabilityCache.size} with known stock)`);
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

      newProducts.set(sku, { url: caUrl, name });
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

    // Method 2: protectedFetch (browser → ScraperAPI) — expensive fallback
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

    const priceMatch = html.match(/\$\s*([\d,]+\.?\d*)/);
    const price = priceMatch ? normalizePrice(priceMatch[1]) : null;

    return {
      inStock: outOfStock ? false : true,
      price,
      image: '',
    };
  }
}

module.exports = PokemonCenterAdapter;
