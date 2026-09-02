const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { walmartSearch, isConfigured } = require('../utils/scraper-api');
const { getProxyUrl } = require('../core/proxy');
const { stealthGet } = require('../utils/stealth-http');

class WalmartAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.walmart.ca';
    this.watchlist = new Set(config.watchlist || []);
    // Search queries for ScraperAPI structured endpoint
    this.searchQueries = [
      // Pokemon (highest demand — multiple queries for coverage)
      'pokemon tcg',
      'pokemon booster box',
      'pokemon elite trainer box',
      'pokemon tcg collection',
      // Other TCGs
      'one piece card game',
      'dragon ball super card game',
      'yu-gi-oh booster box',
      'lorcana booster box',
      'magic the gathering booster box',
      'digimon card game',
      'flesh and blood tcg',
      'weiss schwarz booster',
      'cardfight vanguard',
      'union arena card game',
      'star wars unlimited',
      'naruto boruto card game',
    ];
  }

  /**
   * Fetch a single product page by Walmart SKU/product ID.
   * Uses residential proxy + stealth TLS fingerprint directly — NO ScraperAPI credits.
   * Parses JSON-LD from the product page HTML for structured product data.
   * Returns null if product isn't live yet (404) or blocked.
   */
  async fetchProductPage(productId) {
    const url = `https://www.walmart.ca/ip/${productId}`;
    const proxyUrl = getProxyUrl('residential');

    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 15000,
      });

      if (!html || html.length < 500) {
        logger.warn(`Walmart: watchlist ${productId} — empty/short response (${html ? html.length : 0} bytes)`);
        return null;
      }

      // Detect "Verify Your Identity" bot challenge page
      if (html.includes('Verify Your Identity') || html.includes('robot') || html.includes('captcha')) {
        // Force fresh proxy connection on next request by clearing impit cache
        this._clearStealthCache(proxyUrl);
        this._challengeCount = (this._challengeCount || 0) + 1;
        // Exponential backoff: after repeated challenges, wait longer
        if (this._challengeCount >= 3) {
          const backoffMs = Math.min(this._challengeCount * 5000, 30000);
          logger.warn(`Walmart: watchlist ${productId} — challenge page (${this._challengeCount}x), backing off ${backoffMs / 1000}s`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
        return null;
      }

      // Reset challenge counter on successful non-challenge response
      this._challengeCount = 0;

      // Parse JSON-LD from product page
      const product = this._parseProductPage(html, productId);
      if (!product) {
        if (html.includes('not found') || html.includes('currently unavailable') || html.includes('not exist')) {
          logger.info(`Walmart: watchlist ${productId} — not found/unavailable`);
        } else {
          const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : 'no-title';
          logger.warn(`Walmart: watchlist ${productId} — unparseable (${html.length}b) | title="${title}"`);
        }
        return null;
      }

      product._watchlist = true;
      logger.info(`Walmart: WATCHLIST ${productId} — "${product.name}" | inStock=${product.inStock} | $${product.price || '?'}`);
      return product;
    } catch (err) {
      // Force fresh connection on any error
      this._clearStealthCache(proxyUrl);
      if (err.message.includes('Blocked') || err.message.includes('403') || err.message.includes('503')) {
        logger.warn(`Walmart: watchlist ${productId} — blocked (${err.message})`);
      } else {
        logger.warn(`Walmart: watchlist ${productId} — fetch failed: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Clear cached impit instance to force a fresh proxy IP on next request.
   * Residential proxies rotate IPs per connection — new connection = new IP.
   */
  _clearStealthCache(proxyUrl) {
    try {
      // Access the impit cache from stealth-http module and delete our entry
      const stealthModule = require('../utils/stealth-http');
      if (stealthModule._clearCache) stealthModule._clearCache(proxyUrl);
    } catch {}
  }

  /**
   * Parse Walmart product page HTML for JSON-LD structured data.
   * Walmart embeds a <script type="application/ld+json"> with Product schema.
   */
  _parseProductPage(html, productId) {
    // Method 1: JSON-LD (most reliable)
    let idx = 0;
    while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
      const start = html.indexOf('>', idx) + 1;
      const end = html.indexOf('</script>', start);
      if (end === -1) break;

      try {
        const json = JSON.parse(html.substring(start, end).trim());
        // Could be a single Product or an array
        const productData = json['@type'] === 'Product' ? json :
          (Array.isArray(json) ? json.find(j => j['@type'] === 'Product') : null);

        if (productData) {
          return this._buildProduct(productData, productId);
        }
      } catch (e) {
        // skip malformed JSON-LD blocks
      }
      idx = end;
    }

    // Method 2: __NEXT_DATA__ (Walmart uses Next.js)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const product = this._parseNextData(nextData, productId);
        if (product) return product;
      } catch (e) {
        logger.debug(`Walmart: __NEXT_DATA__ parse failed for ${productId}: ${e.message}`);
      }
    }

    return null;
  }

  /**
   * Build classified product from JSON-LD Product schema.
   */
  _buildProduct(data, productId) {
    const name = data.name;
    if (!name) return null;

    const offers = data.offers;
    let price = null;
    let inStock = false;

    if (offers) {
      // offers can be a single object or array
      const offerList = Array.isArray(offers) ? offers : [offers];
      for (const offer of offerList) {
        if (offer.price != null) {
          price = typeof offer.price === 'number' ? offer.price : normalizePrice(String(offer.price));
        }
        const avail = (offer.availability || '').toLowerCase();
        if (avail.includes('instock')) {
          inStock = true;
        }
      }
    }

    const image = typeof data.image === 'string' ? data.image :
      (Array.isArray(data.image) ? data.image[0] : (data.image?.url || ''));

    return this.classify({
      sku: data.sku || String(productId),
      name,
      price: price || 0,
      currency: 'CAD',
      url: data.url || `https://www.walmart.ca/ip/${productId}`,
      image,
      inStock,
      canAddToCart: inStock,
      shipsToHome: true,
    });
  }

  /**
   * Parse __NEXT_DATA__ for product info (fallback if no JSON-LD).
   */
  _parseNextData(nextData, productId) {
    try {
      // Navigate Next.js data structure — Walmart puts product data in props
      const props = nextData?.props?.pageProps;
      if (!props) return null;

      // Look for product data in various locations
      const item = props.product || props.item || props.initialData?.data?.product;
      if (!item || !item.name) return null;

      const price = item.price?.currentPrice || item.priceInfo?.currentPrice?.price;
      const avail = (item.availabilityStatus || item.availability || '').toLowerCase();
      const inStock = avail.includes('in_stock') || avail.includes('available');

      return this.classify({
        sku: item.usItemId || item.id || String(productId),
        name: item.name,
        price: price || 0,
        currency: 'CAD',
        url: `https://www.walmart.ca/ip/${productId}`,
        image: item.imageInfo?.thumbnailUrl || item.image || '',
        inStock,
        canAddToCart: inStock,
        shipsToHome: true,
      });
    } catch {
      return null;
    }
  }

  async fetchProducts() {
    if (!isConfigured()) {
      throw new Error('Walmart: SCRAPER_API_KEY not configured — structured endpoint required');
    }

    const products = {};

    // Parallel search queries (#6)
    const searchResults = await Promise.allSettled(
      this.searchQueries.map(query =>
        walmartSearch(query, { tld: 'ca', retailerId: this.id })
          .then(data => ({ query, data }))
      )
    );

    for (const result of searchResults) {
      if (result.status === 'rejected') {
        logger.warn(`Walmart: structured search failed: ${result.reason.message}`);
        continue;
      }
      const { query, data } = result.value;
      if (!data) {
        logger.debug(`Walmart: rate-limited for "${query}"`);
        continue;
      }

      const results = data.items || data.results || data.search_results || [];
      if (results.length === 0) {
        logger.warn(`Walmart: 0 results from structured API for "${query}"`, { reason: 'empty_response' });
        continue;
      }

      for (const item of results) {
        try {
          if (!item.name && !item.title) continue;
          const name = item.name || item.title;

          // Skip third-party sellers (#9)
          const seller = (item.seller || item.sold_by || '').toLowerCase();
          if (seller && !seller.includes('walmart')) continue;

          const sku = item.id || item.product_id || item.us_item_id ||
            name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

          const price = typeof item.price === 'number' ? item.price :
            normalizePrice(item.price_string || item.price);

          const url = item.url || item.product_url || item.link ||
            `${this.url}/ip/${sku}`;
          const fullUrl = url.startsWith('http') ? url : `${this.url}${url}`;

          const image = item.image || item.thumbnail || '';
          const avail = (item.availability || '').toLowerCase();
          const inStock = avail ? avail.includes('in stock') || avail.includes('instock') : false;

          const product = this.classify({
            sku: String(sku),
            name,
            price,
            currency: 'CAD',
            url: fullUrl,
            image,
            inStock,
            canAddToCart: inStock,
            shipsToHome: true,
          });

          products[product.sku] = product;
        } catch (err) {
          logger.debug(`Walmart: failed to parse item: ${err.message}`);
        }
      }

      logger.info(`Walmart: "${query}" returned ${results.length} results, ${Object.keys(products).length} total products`);
    }

    return products;
  }
}

module.exports = WalmartAdapter;
