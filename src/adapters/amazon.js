const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.searchUrls = [
      `${this.url}/s?k=pokemon+tcg+booster+box&rh=n%3A6388804011`,
      `${this.url}/s?k=pokemon+elite+trainer+box`,
      `${this.url}/s?k=one+piece+card+game+booster+box`,
      `${this.url}/s?k=pokemon+tcg+collection+box`,
    ];
  }

  async fetchProducts() {
    const products = {};

    for (const searchUrl of this.searchUrls) {
      try {
        let html;
        try {
          html = await this.stealthFetch(searchUrl, { timeoutMs: 20000 });
          // Check if we got a bot challenge page
          if (html.includes('captcha') || html.includes('Robot Check') || html.length < 5000) {
            throw new Error('Bot challenge detected, trying browser fallback');
          }
        } catch (stealthErr) {
          logger.info(`Amazon: stealth HTTP failed (${stealthErr.message}), trying browser fallback`);
          html = await this.browserFetch(searchUrl, { timeoutMs: 30000, waitForSelector: '[data-component-type="s-search-result"]' });
        }

        const $ = cheerio.load(html);

        // Amazon search results
        $('[data-component-type="s-search-result"]').each((_, el) => {
          try {
            const $el = $(el);
            const asin = $el.attr('data-asin');
            if (!asin) return;

            const name = $el.find('h2 .a-text-normal, h2 a span').first().text().trim();
            if (!name) return;

            // Skip sponsored/ad results without TCG relevance
            const lowerName = name.toLowerCase();
            const isTCG = ['pokemon', 'tcg', 'card game', 'booster', 'trainer box', 'one piece'].some(
              kw => lowerName.includes(kw)
            );
            if (!isTCG) return;

            const href = $el.find('h2 a').first().attr('href') || '';
            const url = href.startsWith('http') ? href : `${this.url}${href}`;

            // Price parsing — Amazon has multiple price formats
            const priceWhole = $el.find('.a-price .a-price-whole').first().text().replace(',', '');
            const priceFraction = $el.find('.a-price .a-price-fraction').first().text();
            let price = null;
            if (priceWhole) {
              price = parseFloat(`${priceWhole}.${priceFraction || '00'}`);
            }

            const image = $el.find('.s-image').first().attr('src') || '';

            // Stock status
            const deliveryText = $el.find('.a-row.s-align-children-center').text().toLowerCase();
            const outOfStock = $el.find('.a-color-error').text().toLowerCase().includes('currently unavailable') ||
              $el.text().toLowerCase().includes('currently unavailable');

            const product = this.classify({
              sku: asin,
              name,
              price,
              currency: 'CAD',
              url,
              image,
              inStock: !outOfStock && price != null,
              canAddToCart: !outOfStock && price != null,
              shipsToHome: true,
            });

            products[product.sku] = product;
          } catch (err) {
            logger.debug(`Amazon: failed to parse result: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`Amazon: failed to fetch search: ${err.message}`);
      }
    }

    return products;
  }
}

module.exports = AmazonAdapter;
