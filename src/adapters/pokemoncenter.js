const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { FAILURE_REASONS, classifyError } = require('../core/failure-reasons');

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
    this.availabilityCache = new Map(); // sku -> { inStock, price, image }
    this.lastSitemapScan = 0;
    this.SITEMAP_INTERVAL = 30 * 60 * 1000; // 30 minutes

    // Availability check rotation
    this.checkIndex = 0;
    this.CHECKS_PER_POLL = 12;
  }

  isChallengePage(html) {
    return html.includes('Pardon Our Interruption') ||
      html.includes('distil_referrer') ||
      html.includes('Incapsula') ||
      (html.length < 5000 && !html.includes('<loc>') && !html.includes('<html'));
  }

  async fetchProducts() {
    const products = {};

    // Phase 1: Discover products from sitemap (every 30 min)
    if (Date.now() - this.lastSitemapScan > this.SITEMAP_INTERVAL || this.sitemapProducts.size === 0) {
      await this.scanSitemap();
      this.lastSitemapScan = Date.now();
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
          this.availabilityCache.set(sku, data);
          checked++;
        } else if (failReason) {
          failureCounts[failReason] = (failureCounts[failReason] || 0) + 1;
        }
      } catch (err) {
        const reason = classifyError(err);
        failureCounts[reason] = (failureCounts[reason] || 0) + 1;
        logger.debug(`Pokemon Center: check failed for ${sku}: ${err.message}`);
      }
    }
    this.checkIndex = (start + batchSize) % entries.length;

    // Phase 3: Build full product list — use cached availability for all products
    for (const [sku, meta] of this.sitemapProducts) {
      const avail = this.availabilityCache.get(sku) || { inStock: true, price: null, image: '' };
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

    const failureSummary = Object.keys(failureCounts).length > 0
      ? Object.entries(failureCounts).map(([r, c]) => `${r}:${c}`).join(', ')
      : 'none';
    logger.info(`Pokemon Center: ${Object.keys(products).length} products (${checked}/${batchSize} checked) — failures: ${failureSummary}`);
    return products;
  }

  async scanSitemap() {
    let xml;

    // Try cookieFetch first (solves Incapsula once, caches cookies for reuse)
    try {
      xml = await this.cookieFetch(this.sitemapUrl, {
        domain: this.domain,
        seedUrl: this.seedUrl,
        challengeDetector: (h) => !h.includes('<loc>') || this.isChallengePage(h),
        timeoutMs: 45000,
      });
    } catch (err) {
      logger.debug(`Pokemon Center: cookieFetch sitemap failed: ${err.message}`);
      // Fall back to protectedFetch (browser → ScraperAPI)
      try {
        xml = await this.protectedFetch(this.sitemapUrl, {
          timeoutMs: 45000,
          challengeDetector: (h) => !h.includes('<loc>') || this.isChallengePage(h),
          scraperOpts: { render: false, ultraPremium: true },
        });
      } catch (err2) {
        if (this.sitemapProducts.size > 0) {
          logger.warn(`Pokemon Center: sitemap fetch failed, using ${this.sitemapProducts.size} cached products`);
          return;
        }
        throw new Error(`Sitemap unreachable: ${err2.message}`);
      }
    }

    if (!xml || !xml.includes('<loc>') || this.isChallengePage(xml)) {
      if (this.sitemapProducts.size > 0) {
        logger.warn('Pokemon Center: sitemap returned challenge/empty, using cached products');
        return;
      }
      throw new Error('Sitemap returned challenge page — all methods failed');
    }

    // Parse product URLs from sitemap
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
    }

    logger.info(`Pokemon Center: sitemap found ${newProducts.size} TCG products (${urlMatches.length} total URLs)`);
  }

  async checkProductAvailability(sku, meta) {
    let html;

    // Try cookieFetch first (reuses Incapsula session cookies — fast HTTP, no browser per page)
    try {
      html = await this.cookieFetch(meta.url, {
        domain: this.domain,
        seedUrl: this.seedUrl,
        challengeDetector: (h) => this.isChallengePage(h),
        timeoutMs: 15000,
        waitForSelector: '[data-testid="add-to-cart"]',
      });
    } catch (err) {
      const reason = classifyError(err);
      logger.warn(`Pokemon Center: fetch failed for ${sku}`, { reason, url: meta.url, error: err.message });
      return { data: null, failReason: reason };
    }

    if (!html) {
      logger.debug(`Pokemon Center: empty response for ${sku}`);
      return { data: null, failReason: FAILURE_REASONS.EMPTY_RESPONSE };
    }
    if (this.isChallengePage(html)) {
      logger.debug(`Pokemon Center: challenge page for ${sku}`);
      return { data: null, failReason: FAILURE_REASONS.BOT_CHALLENGE };
    }

    // Try JSON-LD first (most reliable)
    const jsonLd = this.parseJsonLd(html);
    if (jsonLd) return { data: jsonLd, failReason: null };

    // Try __NEXT_DATA__ embedded JSON
    const nextData = this.parseNextData(html);
    if (nextData) return { data: nextData, failReason: null };

    // Fallback: HTML text markers
    const markers = this.parseHtmlMarkers(html);
    if (markers) return { data: markers, failReason: null };

    logger.debug(`Pokemon Center: no parseable data for ${sku}`);
    return { data: null, failReason: FAILURE_REASONS.NO_MARKERS };
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
