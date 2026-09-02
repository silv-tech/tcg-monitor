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
    this.SITEMAP_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours (products don't change that fast)

    // Availability check rotation
    this.checkIndex = 0;
    this.CHECKS_PER_POLL = 10;

    // Track consecutive full-poll failures to avoid noisy error logging
    this._consecutiveFailures = 0;
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
    if (Date.now() - this.lastSitemapScan > this.SITEMAP_INTERVAL || this.sitemapProducts.size === 0) {
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

    // Phase 2: Check availability for a rotating batch of products
    const entries = [...this.sitemapProducts.entries()];
    const start = this.checkIndex % entries.length;
    const batchSize = Math.min(this.CHECKS_PER_POLL, entries.length);

    let checked = 0;
    const failureCounts = {};
    for (let i = 0; i < batchSize; i++) {
      const idx = (start + i) % entries.length;
      const [sku, meta] = entries[idx];
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
    this.checkIndex = (start + batchSize) % entries.length;

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

    logger.info(`Pokemon Center: ${Object.keys(products).length} products (${checked}/${batchSize} fresh, ${this.availabilityCache.size} cached)`);
    return products;
  }

  async scanSitemap() {
    let xml;

    // Method 1: Stealth HTTP (impit) — fastest, free, works if sitemap isn't behind challenge
    try {
      const proxyUrl = getProxyUrl('residential');
      xml = await stealthGet(this.sitemapUrl, {
        proxyUrl,
        maxRetries: 2,
        timeoutMs: 20000,
        headers: {
          'Accept': 'application/xml, text/xml, */*',
        },
      });
      if (xml && xml.includes('<loc>') && !this.isChallengePage(xml)) {
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
      logger.info(`Pokemon Center: sitemap parsed — ${newProducts.size} TCG products (${urlMatches.length} total URLs)`);
    } else if (urlMatches.length > 0) {
      logger.warn(`Pokemon Center: sitemap had ${urlMatches.length} URLs but 0 matched TCG keywords`);
    }
  }

  async checkProductAvailability(sku, meta) {
    // Method 1: Stealth HTTP (impit) — free, fast
    // Many product pages serve JSON-LD and __NEXT_DATA__ even without JS execution
    try {
      const proxyUrl = getProxyUrl('residential');
      const html = await stealthGet(meta.url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 15000,
      });

      if (html && !this.isChallengePage(html)) {
        const data = this._parseProductHtml(html);
        if (data) return { data, failReason: null };
      }
    } catch {
      // Stealth failed — try next method
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
