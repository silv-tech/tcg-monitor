const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

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

    // Availability check rotation — check a batch of products each poll
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
    for (let i = 0; i < batchSize; i++) {
      const idx = (start + i) % entries.length;
      const [sku, meta] = entries[idx];
      try {
        const avail = await this.checkProductAvailability(sku, meta);
        if (avail) {
          this.availabilityCache.set(sku, avail);
          checked++;
        }
      } catch (err) {
        logger.debug(`Pokemon Center: check failed for ${sku}: ${err.message}`);
      }
    }
    this.checkIndex = (start + batchSize) % entries.length;

    // Phase 3: Build full product list — use cached availability for all products
    // Default: inStock true (listed in sitemap = assumed available until proven otherwise)
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

    logger.info(`Pokemon Center: ${Object.keys(products).length} products (${checked}/${batchSize} checked this poll)`);
    return products;
  }

  async scanSitemap() {
    let xml;

    // Try cookieFetch first (solves Incapsula challenge via Playwright cookies)
    try {
      xml = await this.cookieFetch(this.sitemapUrl, {
        domain: this.domain,
        seedUrl: this.seedUrl,
        challengeDetector: (html) => this.isChallengePage(html),
        timeoutMs: 30000,
      });
    } catch (cookieErr) {
      // Try stealth HTTP as fallback
      try {
        xml = await this.stealthFetch(this.sitemapUrl, { timeoutMs: 30000 });
      } catch (stealthErr) {
        // Last resort: full browser rendering
        try {
          xml = await this.browserFetch(this.sitemapUrl, { timeoutMs: 45000 });
        } catch (browserErr) {
          if (this.sitemapProducts.size > 0) {
            logger.warn(`Pokemon Center: all sitemap fetches failed, using ${this.sitemapProducts.size} cached products`);
            return;
          }
          throw new Error(`Sitemap unreachable: cookie(${cookieErr.message}), stealth(${stealthErr.message}), browser(${browserErr.message})`);
        }
      }
    }

    if (!xml || !xml.includes('<loc>') || this.isChallengePage(xml)) {
      if (this.sitemapProducts.size > 0) {
        logger.warn('Pokemon Center: sitemap returned challenge/empty, using cached products');
        return;
      }
      throw new Error('Sitemap returned challenge page — all bypass methods failed');
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
      const caUrl = url.includes('/en-ca/') ? url : url.replace('/product/', '/en-ca/product/');

      newProducts.set(sku, { url: caUrl, name });
    }

    if (newProducts.size > 0) {
      this.sitemapProducts = newProducts;
    }

    logger.info(`Pokemon Center: sitemap found ${newProducts.size} TCG products (${urlMatches.length} total URLs)`);
  }

  async checkProductAvailability(sku, meta) {
    let html;

    try {
      html = await this.cookieFetch(meta.url, {
        domain: this.domain,
        seedUrl: this.seedUrl,
        challengeDetector: (h) => this.isChallengePage(h),
        timeoutMs: 20000,
      });
    } catch {
      // If cookieFetch fails, try stealth
      try {
        html = await this.stealthFetch(meta.url, { timeoutMs: 15000 });
      } catch {
        return null;
      }
    }

    if (!html || this.isChallengePage(html)) return null;

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
      } catch { /* skip malformed JSON-LD */ }
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
    } catch {
      return null;
    }
  }

  parseHtmlMarkers(html) {
    const lower = html.toLowerCase();
    const outOfStock = lower.includes('out of stock') || lower.includes('sold out') ||
      lower.includes('currently unavailable') || lower.includes('"outofstock"');
    const hasAddToCart = lower.includes('add to cart') || lower.includes('add to bag');

    // Can't determine availability if neither marker found
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
