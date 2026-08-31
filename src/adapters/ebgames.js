const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

class EBGamesAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.searchUrls = [
      `${this.url}/SearchResult/QuickSearch?q=pokemon+tcg&lang=en-CA&platform=Trading+Cards`,
      `${this.url}/SearchResult/QuickSearch?q=one+piece+card+game&lang=en-CA&platform=Trading+Cards`,
      `${this.url}/SearchResult/QuickSearch?q=dragon+ball+super+card+game&lang=en-CA&platform=Trading+Cards`,
    ];
  }

  async fetchProducts() {
    const products = {};

    for (const searchUrl of this.searchUrls) {
      try {
        const html = await this.fetch(searchUrl);
        const $ = cheerio.load(html);

        $('.product').each((_, el) => {
          try {
            const $el = $(el);
            const name = $el.find('.product-name, .prodTitle, h3 a, .title a').first().text().trim();
            if (!name) return;

            const href = $el.find('a[href*="/product/"]').first().attr('href') || '';
            const url = href.startsWith('http') ? href : `${this.url}${href}`;
            const sku = href.match(/\/(\d+)(?:\?|$)/) ? href.match(/\/(\d+)(?:\?|$)/)[1]
              : name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

            const priceText = $el.find('.prodPrice, .price, .actual-price').first().text();
            const price = normalizePrice(priceText);

            const image = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';

            const outOfStock = $el.find('.out-of-stock, .unavailable').length > 0;
            const preorder = $el.find('.preorder, .pre-order').length > 0 ||
              name.toLowerCase().includes('pre-order');

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

            if (preorder && !outOfStock) {
              product._preorder = true;
            }

            products[product.sku] = product;
          } catch (err) {
            logger.debug(`EB Games: failed to parse product element: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`EB Games: failed to fetch ${searchUrl}: ${err.message}`);
      }
    }

    // If ALL search URLs returned 0 results, the site is likely down/blocked
    if (Object.keys(products).length === 0 && this.searchUrls.length > 0) {
      throw new Error('All search URLs returned 0 products — site may be down or blocking');
    }

    return products;
  }
}

module.exports = EBGamesAdapter;
