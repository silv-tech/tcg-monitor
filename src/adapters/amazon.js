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

    // Parallel search queries (#6) — all queries fire simultaneously
    const searchResults = await Promise.allSettled(
      this.searchQueries.map(query =>
        amazonSearch(query, { tld: 'ca', retailerId: this.id })
          .then(data => ({ query, data }))
      )
    );

    for (const result of searchResults) {
      if (result.status === 'rejected') {
        logger.warn(`Amazon: structured search failed: ${result.reason.message}`);
        continue;
      }
      const { query, data } = result.value;
      if (!data) {
        logger.debug(`Amazon: rate-limited for "${query}"`);
        continue;
      }

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

          const lowerName = name.toLowerCase();
          const isTCG = ['pokemon', 'tcg', 'booster', 'trainer box', 'one piece',
            'dragon ball', 'lorcana', 'yugioh', 'yu-gi-oh', 'magic the gathering',
            'trading card'].some(kw => lowerName.includes(kw));
          if (!isTCG) continue;

          // Skip third-party sellers — only show Amazon-fulfilled (#9)
          const seller = (item.sold_by || item.seller || '').toLowerCase();
          if (seller && !seller.includes('amazon')) continue;

          const price = typeof item.price === 'number' ? item.price :
            normalizePrice(item.price_string || item.price);

          const url = item.url || item.product_url || item.link ||
            `${this.url}/dp/${asin}`;
          const fullUrl = url.startsWith('http') ? url : `${this.url}${url}`;

          const image = item.image || item.thumbnail || '';
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
    }

    return products;
  }
}

module.exports = AmazonAdapter;
