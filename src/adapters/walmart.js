const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { walmartSearch, isConfigured } = require('../utils/scraper-api');

class WalmartAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.walmart.ca';
    // Search queries for ScraperAPI structured endpoint
    this.searchQueries = [
      'pokemon tcg',
      'pokemon booster box',
      'pokemon elite trainer box',
      'one piece card game',
      'dragon ball super card game',
    ];
  }

  async fetchProducts() {
    if (!isConfigured()) {
      throw new Error('Walmart: SCRAPER_API_KEY not configured — structured endpoint required');
    }

    const products = {};

    for (const query of this.searchQueries) {
      try {
        const data = await walmartSearch(query, {
          tld: 'ca',
          retailerId: this.id,
        });

        if (!data) {
          logger.debug(`Walmart: rate-limited for "${query}"`);
          continue;
        }

        // ScraperAPI structured endpoint returns { results: [...] } or { search_results: [...] }
        const results = data.results || data.search_results || data.organic_results || [];

        if (results.length === 0) {
          logger.warn(`Walmart: 0 results from structured API for "${query}"`, { reason: 'empty_response' });
          continue;
        }

        for (const item of results) {
          try {
            if (!item.name && !item.title) continue;

            const name = item.name || item.title;

            // Skip third-party sellers — only show "Sold and shipped by Walmart"
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

            // Availability check
            const avail = (item.availability || '').toLowerCase();
            const inStock = avail ? avail.includes('in stock') || avail.includes('instock') : true;

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
      } catch (err) {
        logger.warn(`Walmart: structured search failed for "${query}": ${err.message}`);
      }
    }

    return products;
  }
}

module.exports = WalmartAdapter;
