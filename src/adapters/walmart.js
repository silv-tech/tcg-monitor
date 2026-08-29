const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

class WalmartAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    // Walmart Canada search API
    this.searchUrls = [
      `${this.url}/search?q=pokemon+tcg`,
      `${this.url}/search?q=pokemon+booster+box`,
      `${this.url}/search?q=pokemon+elite+trainer+box`,
      `${this.url}/search?q=one+piece+card+game`,
      `${this.url}/search?q=dragon+ball+super+card+game`,
    ];
  }

  async fetchProducts() {
    const products = {};

    for (const searchUrl of this.searchUrls) {
      try {
        const html = await this.stealthFetch(searchUrl, {
          timeoutMs: 20000,
        });

        // Walmart embeds product data in __NEXT_DATA__ or window.__PRELOADED_STATE__
        const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
        if (nextDataMatch) {
          try {
            const data = JSON.parse(nextDataMatch[1]);
            this.parseNextData(data, products);
            continue;
          } catch (e) {
            logger.debug(`Walmart: failed to parse __NEXT_DATA__: ${e.message}`);
          }
        }

        // Fallback: try embedded JSON state
        const stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.+?});?\s*<\/script>/s);
        if (stateMatch) {
          try {
            const state = JSON.parse(stateMatch[1]);
            this.parsePreloadedState(state, products);
            continue;
          } catch (e) {
            logger.debug(`Walmart: failed to parse preloaded state: ${e.message}`);
          }
        }

        // Last resort: HTML parsing
        const $ = cheerio.load(html);
        $('[data-automation="product"], .product-tile, [data-product-id]').each((_, el) => {
          try {
            const $el = $(el);
            const name = $el.find('[data-automation="name"], .product-title, .title').first().text().trim();
            if (!name) return;

            const href = $el.find('a[href*="/ip/"]').first().attr('href') || '';
            const url = href.startsWith('http') ? href : `${this.url}${href}`;
            const skuMatch = href.match(/\/ip\/([A-Z0-9]+)/i);
            const sku = skuMatch ? skuMatch[1] : name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

            const priceText = $el.find('[data-automation="current-price"], .price-current').first().text();
            const price = normalizePrice(priceText);

            const image = $el.find('img').first().attr('src') || '';

            const outOfStock = $el.find('.oos-label, .out-of-stock').length > 0 ||
              $el.text().toLowerCase().includes('out of stock');

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
            logger.debug(`Walmart: failed to parse element: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`Walmart: failed to fetch ${searchUrl}: ${err.message}`);
      }
    }

    return products;
  }

  parseNextData(data, products) {
    try {
      const stacks = data?.props?.pageProps?.initialData?.searchResult?.itemStacks || [];
      for (const stack of stacks) {
        const items = stack?.items || [];
        for (const item of items) {
          // Skip non-product entries (ads, placeholders)
          if (!item.name || item.__typename === 'AdPlaceholder' || item.__typename === 'TileTakeOverProductPlaceholder') continue;

          const product = this.classify({
            sku: item.usItemId || item.id || item.canonicalUrl?.split('/').pop(),
            name: item.name,
            price: item.price || normalizePrice(item.priceInfo?.linePrice),
            currency: 'CAD',
            url: item.canonicalUrl ? `${this.url}${item.canonicalUrl}` : this.url,
            image: item.imageInfo?.thumbnailUrl || item.image || '',
            inStock: item.availabilityStatusV2?.value === 'IN_STOCK' || !item.isOutOfStock,
            canAddToCart: item.canAddToCart !== false,
            shipsToHome: !(item.fulfillmentTitle || '').includes('not_available'),
          });
          products[product.sku] = product;
        }
      }
    } catch (err) {
      logger.debug(`Walmart: parseNextData error: ${err.message}`);
    }
  }

  parsePreloadedState(state, products) {
    try {
      const items = Object.values(state?.product || {});
      for (const item of items) {
        if (!item.name) continue;
        const product = this.classify({
          sku: item.usItemId || item.id,
          name: item.name,
          price: item.price?.amount || item.currentPrice,
          currency: 'CAD',
          url: `${this.url}/ip/${item.usItemId || item.id}`,
          image: item.imageUrl || item.thumbnailUrl || '',
          inStock: item.stockStatus === 'IN_STOCK',
          canAddToCart: item.canAddToCart !== false,
          shipsToHome: true,
        });
        products[product.sku] = product;
      }
    } catch (err) {
      logger.debug(`Walmart: parsePreloadedState error: ${err.message}`);
    }
  }
}

module.exports = WalmartAdapter;
