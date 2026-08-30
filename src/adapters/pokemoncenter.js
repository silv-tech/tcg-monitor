const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

class PokemonCenterAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    // Pokemon Center uses a JSON API for search
    this.apiBase = 'https://www.pokemoncenter.com/api';
    this.searchQueries = ['tcg', 'booster', 'elite trainer box', 'tin', 'collection'];
  }

  async fetchProducts() {
    const products = {};

    for (const query of this.searchQueries) {
      try {
        // Pokemon Center uses Algolia-powered search or internal API
        const searchUrl = `${this.url}/search?q=${encodeURIComponent(query)}`;
        let html;
        try {
          html = await this.stealthFetch(searchUrl, { timeoutMs: 25000 });
          if (html.includes('incapsula') || html.includes('_Incapsula_Resource') || html.length < 3000) {
            throw new Error('Incapsula challenge detected');
          }
        } catch (stealthErr) {
          logger.info(`Pokemon Center: stealth failed (${stealthErr.message}), trying browser fallback`);
          html = await this.browserFetch(searchUrl, { timeoutMs: 30000, waitForSelector: '[data-testid="product-card"], .product-card' });
        }

        // Try to extract JSON data from script tags (Next.js / SSR data)
        const jsonMatch = html.match(/__NEXT_DATA__\s*=\s*({.+?})\s*;?\s*<\/script>/s);
        if (jsonMatch) {
          try {
            const data = JSON.parse(jsonMatch[1]);
            this.parseNextData(data, products);
            continue;
          } catch (e) {
            // Fall through to HTML parsing
          }
        }

        // Fallback: parse HTML with cheerio
        const cheerio = require('cheerio');
        const $ = cheerio.load(html);

        $('[data-testid="product-card"], .product-card, .product-tile').each((_, el) => {
          try {
            const $el = $(el);
            const name = $el.find('[data-testid="product-name"], .product-name, h3').first().text().trim();
            if (!name) return;

            const href = $el.find('a').first().attr('href') || '';
            const url = href.startsWith('http') ? href : `${this.url}${href}`;
            const sku = href.split('/').pop() || name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

            const priceText = $el.find('[data-testid="product-price"], .price').first().text();
            const price = normalizePrice(priceText);

            const image = $el.find('img').first().attr('src') || '';

            const outOfStock = $el.find('.out-of-stock, [data-testid="oos"]').length > 0 ||
              $el.text().toLowerCase().includes('out of stock') ||
              $el.text().toLowerCase().includes('sold out');

            const product = this.classify({
              sku,
              name,
              price,
              currency: 'CAD',
              url,
              image,
              inStock: !outOfStock,
              canAddToCart: !outOfStock,
              shipsToHome: true,
            });

            products[product.sku] = product;
          } catch (err) {
            logger.debug(`Pokemon Center: failed to parse element: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`Pokemon Center: failed search for "${query}": ${err.message}`);
      }
    }

    return products;
  }

  parseNextData(data, products) {
    try {
      const pageProps = data?.props?.pageProps;
      if (!pageProps) return;

      const items = pageProps.searchResults?.products || pageProps.products || [];
      for (const item of items) {
        const product = this.classify({
          sku: item.sku || item.id || item.slug,
          name: item.name || item.title,
          price: typeof item.price === 'number' ? item.price : normalizePrice(item.price),
          currency: 'CAD',
          url: `${this.url}/product/${item.slug || item.sku}`,
          image: item.image || item.images?.[0]?.url || '',
          inStock: item.inStock !== false && item.availability !== 'OutOfStock',
          canAddToCart: item.purchasable !== false,
          shipsToHome: true,
        });
        products[product.sku] = product;
      }
    } catch (err) {
      logger.debug(`Pokemon Center: parseNextData failed: ${err.message}`);
    }
  }
}

module.exports = PokemonCenterAdapter;
