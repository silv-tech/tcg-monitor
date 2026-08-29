const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

class CostcoAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.searchUrls = [
      `${this.url}/ca/pokemon.html`,
      `${this.url}/ca/CatalogSearch?dept=All&keyword=pokemon+tcg`,
      `${this.url}/ca/CatalogSearch?dept=All&keyword=trading+card+game`,
    ];
  }

  async fetchProducts() {
    const products = {};

    for (const searchUrl of this.searchUrls) {
      try {
        const html = await this.fetch(searchUrl, {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        const $ = cheerio.load(html);

        $('.product, .product-tile, [data-product-id]').each((_, el) => {
          try {
            const $el = $(el);
            const name = $el.find('.description, .product-title, h2 a, p.description a').first().text().trim();
            if (!name) return;

            const sku = $el.attr('data-product-id') ||
              $el.find('[data-product-id]').attr('data-product-id') ||
              name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

            const href = $el.find('a[href*=".product."]').first().attr('href') ||
              $el.find('a').first().attr('href') || '';
            const url = href.startsWith('http') ? href : `${this.url}${href}`;

            const priceText = $el.find('.price, .your-price span').first().text();
            const price = normalizePrice(priceText);

            const image = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';

            const outOfStock = $el.find('.out-of-stock, .oos').length > 0 ||
              $el.text().toLowerCase().includes('out of stock');

            const product = this.classify({
              sku,
              name,
              price,
              currency: 'CAD',
              url,
              image: image.startsWith('http') ? image : `${this.url}${image}`,
              inStock: !outOfStock,
              canAddToCart: !outOfStock,
              shipsToHome: true,
            });

            products[product.sku] = product;
          } catch (err) {
            logger.debug(`Costco: failed to parse product element: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`Costco: failed to fetch ${searchUrl}: ${err.message}`);
      }
    }

    return products;
  }
}

module.exports = CostcoAdapter;
