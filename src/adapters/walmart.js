const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { walmartSearch, walmartProductLookup, isConfigured } = require('../utils/scraper-api');

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
   * Used by scheduler.pollWatchlist() for early SKU detection.
   * Returns null if product isn't live yet (404) or rate-limited.
   */
  async fetchProductPage(productId) {
    if (!isConfigured()) return null;

    try {
      const data = await walmartProductLookup(productId, { retailerId: this.id });
      if (!data) return null; // rate-limited or 404

      // ScraperAPI autoparse returns product data in various formats
      // Try to extract from structured response
      const name = data.product_name || data.name || data.title;
      if (!name) {
        logger.debug(`Walmart: watchlist ${productId} — page returned but no product name (may be placeholder)`);
        return null;
      }

      const price = typeof data.price === 'number' ? data.price :
        normalizePrice(data.price_string || data.price || data.product_price);

      // Check offers array if present (ScraperAPI structured format)
      let inStock = false;
      let canAddToCart = false;
      if (data.offers && Array.isArray(data.offers)) {
        for (const offer of data.offers) {
          const avail = (offer.availability || '').toLowerCase();
          if (avail.includes('instock') || avail.includes('in stock') || avail.includes('in_stock')) {
            inStock = true;
            canAddToCart = true;
            break;
          }
        }
      } else {
        // Fallback: check top-level availability
        const avail = (data.availability || data.stock_status || '').toLowerCase();
        inStock = avail.includes('in stock') || avail.includes('instock') || avail.includes('in_stock');
        canAddToCart = inStock;
      }

      const image = data.image || data.product_image || data.thumbnail || '';
      const url = data.url || data.product_url || `https://www.walmart.ca/ip/${productId}`;

      const product = this.classify({
        sku: String(productId),
        name,
        price: price || 0,
        currency: 'CAD',
        url,
        image,
        inStock,
        canAddToCart,
        shipsToHome: true,
      });

      product._watchlist = true;
      logger.info(`Walmart: WATCHLIST ${productId} — "${name}" | inStock=${inStock} | $${price || '?'}`);
      return product;
    } catch (err) {
      logger.debug(`Walmart: watchlist ${productId} fetch failed: ${err.message}`);
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
