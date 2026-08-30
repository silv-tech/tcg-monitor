const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

class CostcoAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    // Costco's search API is behind Akamai — use sitemap discovery + product page monitoring
    this.sitemapUrl = `${this.url}/sitemap_i_001.xml`;
    this.tcgKeywords = [
      'pokemon', 'pokmon', 'pokémon', 'tcg', 'trading-card', 'trading+card',
      'trading%20card', 'one-piece', 'lorcana', 'magic-the-gathering',
      'yugioh', 'yu-gi-oh', 'dragon-ball', 'naruto', 'booster',
      'elite-trainer', 'trainer-box', 'collector', 'card-game',
    ];
    this.knownProductIds = new Set();
    this.lastSitemapScan = 0;
    this.SITEMAP_INTERVAL = 6 * 60 * 60 * 1000; // Rescan sitemap every 6 hours
  }

  async fetchProducts() {
    const products = {};

    // Phase 1: Discover new product URLs from sitemap (every 6 hours)
    if (Date.now() - this.lastSitemapScan > this.SITEMAP_INTERVAL) {
      await this.scanSitemap();
      this.lastSitemapScan = Date.now();
    }

    // Phase 2: Check each known product page for stock/price changes
    for (const productId of this.knownProductIds) {
      try {
        const product = await this.fetchProductPage(productId);
        if (product) {
          products[product.sku] = product;
        }
      } catch (err) {
        logger.debug(`Costco: failed to fetch product ${productId}: ${err.message}`);
      }
    }

    return products;
  }

  async scanSitemap() {
    const sitemapUrls = [
      `${this.url}/sitemap_i_001.xml`,
      `${this.url}/sitemap_p_001.xml`,
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const xml = await this.fetch(sitemapUrl, { timeoutMs: 30000 });
        const $ = cheerio.load(xml, { xmlMode: true });

        $('url > loc').each((_, el) => {
          const url = $(el).text().trim().toLowerCase();
          if (this.tcgKeywords.some(kw => url.includes(kw))) {
            // Extract product ID from URL — /p/-/slug/ITEMID or /product-name.ITEMID.html
            const idMatch = url.match(/\/(\d{5,})(?:\.html)?$/);
            if (idMatch) {
              this.knownProductIds.add(idMatch[1]);
            }
          }
        });
      } catch (err) {
        logger.warn(`Costco: sitemap scan failed for ${sitemapUrl}: ${err.message}`);
      }
    }

    logger.info(`Costco: sitemap scan found ${this.knownProductIds.size} TCG product IDs`);
  }

  async fetchProductPage(productId) {
    // The /p/-/x/ITEMID format works — slug is ignored by server
    const url = `${this.url}/p/-/tcg/${productId}`;
    const html = await this.fetch(url, { timeoutMs: 15000 });

    const $ = cheerio.load(html);

    // Parse JSON-LD structured data
    let productData = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'Product') {
          productData = json;
        }
      } catch (e) {
        // skip invalid JSON-LD
      }
    });

    if (!productData) {
      logger.debug(`Costco: no JSON-LD Product data for ${productId}`);
      return null;
    }

    const availability = productData.offers?.availability || '';
    const inStock = availability.includes('InStock');

    return this.classify({
      sku: productData.sku || productId,
      name: productData.name,
      price: typeof productData.offers?.price === 'number'
        ? productData.offers.price
        : normalizePrice(String(productData.offers?.price)),
      currency: productData.offers?.priceCurrency || 'CAD',
      url: productData.url || `${this.url}/p/-/tcg/${productId}`,
      image: productData.image || '',
      inStock,
      canAddToCart: inStock,
      shipsToHome: true,
    });
  }

  // Allow manually adding product IDs (e.g. from admin dashboard)
  addProductId(id) {
    this.knownProductIds.add(id);
  }

  removeProductId(id) {
    this.knownProductIds.delete(id);
  }
}

module.exports = CostcoAdapter;
