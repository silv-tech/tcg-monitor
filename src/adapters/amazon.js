const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { amazonSearch, isConfigured } = require('../utils/scraper-api');

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    // Search queries for ScraperAPI structured endpoint
    this.searchQueries = [
      'pokemon tcg booster box',
      'pokemon elite trainer box',
      'one piece card game booster box',
      'pokemon tcg collection box',
    ];
  }

  async fetchProducts() {
    if (!isConfigured()) {
      throw new Error('Amazon: SCRAPER_API_KEY not configured — structured endpoint required');
    }

    const products = {};

    for (const query of this.searchQueries) {
      try {
        const data = await amazonSearch(query, {
          tld: 'ca',
          retailerId: this.id,
        });

        if (!data) {
          logger.debug(`Amazon: rate-limited for "${query}"`);
          continue;
        }

        // ScraperAPI structured endpoint returns { results: [...] } or { organic_results: [...] }
        const results = data.results || data.organic_results || data.search_results || [];

        if (results.length === 0) {
          logger.warn(`Amazon: 0 results from structured API for "${query}"`, { reason: 'empty_response' });
          continue;
        }

        for (const item of results) {
          try {
            const asin = item.asin;
            if (!asin) continue;

            const name = item.name || item.title;
            if (!name) continue;

            // Skip non-TCG results
            const lowerName = name.toLowerCase();
            const isTCG = ['pokemon', 'tcg', 'card game', 'booster', 'trainer box', 'one piece'].some(
              kw => lowerName.includes(kw)
            );
            if (!isTCG) continue;

            // Skip third-party sellers — only show Amazon-fulfilled
            const seller = (item.sold_by || item.seller || '').toLowerCase();
            if (seller && !seller.includes('amazon')) continue;

            const price = typeof item.price === 'number' ? item.price :
              normalizePrice(item.price_string || item.price);

            const url = item.url || item.product_url || item.link ||
              `${this.url}/dp/${asin}`;
            const fullUrl = url.startsWith('http') ? url : `${this.url}${url}`;

            const image = item.image || item.thumbnail || '';

            // Stock: if we have price, assume in stock (structured API only returns available items)
            const inStock = price != null;

            const product = this.classify({
              sku: asin,
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
            logger.debug(`Amazon: failed to parse item: ${err.message}`);
          }
        }

        logger.info(`Amazon: "${query}" returned ${results.length} results, ${Object.keys(products).length} total products`);
      } catch (err) {
        logger.warn(`Amazon: structured search failed for "${query}": ${err.message}`);
      }
    }

    return products;
  }
}

module.exports = AmazonAdapter;
