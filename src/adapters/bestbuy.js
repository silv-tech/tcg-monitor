const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');

class BestBuyAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.searchQueries = config.searchQueries || [
      'pokemon booster box',
      'pokemon elite trainer box',
      'pokemon tcg',
      'one piece tcg',
      'dragon ball tcg',
      'lorcana',
    ];
    this.categoryId = config.categoryId || '';
    this.pageSize = 48;
  }

  async fetchProducts() {
    const products = {};
    const allSkus = [];

    // Phase 1: Search for products
    for (const query of this.searchQueries) {
      try {
        const searchUrl = `${this.url}/api/v2/json/search?query=${encodeURIComponent(query)}&lang=en-CA&pageSize=${this.pageSize}`;
        const data = await this.fetch(searchUrl, { json: true, timeoutMs: 15000 });

        if (!data.products || data.products.length === 0) continue;

        for (const item of data.products) {
          if (!item.sku || !item.name) continue;
          // Skip non-visible or in-store-only items
          if (!item.isVisible) continue;

          const price = item.salePrice || item.regularPrice;
          products[item.sku] = this.classify({
            sku: item.sku,
            name: item.name,
            price: typeof price === 'number' ? price : parseFloat(price) || 0,
            currency: 'CAD',
            url: `${this.url}${item.productUrl}`,
            image: item.highResImage || item.thumbnailImage || '',
            inStock: false, // Will be updated by availability check
            canAddToCart: false,
            isPreorderable: item.isPreorderable || false,
            isMarketplace: item.isMarketplace || false,
            seller: item.seller?.name || 'Best Buy',
            isOnSale: item.salePrice < item.regularPrice,
            regularPrice: item.regularPrice,
            shipsToHome: !item.isInStoreOnly,
          });

          allSkus.push(item.sku);
        }
      } catch (err) {
        logger.warn(`Best Buy: search failed for "${query}": ${err.message}`);
      }
    }

    // Phase 2: Batch check availability for all discovered SKUs
    if (allSkus.length > 0) {
      await this.checkAvailability(allSkus, products);
    }

    return products;
  }

  async checkAvailability(skus, products) {
    // Best Buy availability API requires browser-like TLS + sec-fetch headers (412 otherwise)
    const availHeaders = {
      'Accept': 'application/vnd.bestbuy.standardproduct.v1+json',
      'sec-ch-ua': '"Google Chrome";v="127"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };

    // Batch up to 10 SKUs at a time
    const batchSize = 10;

    for (let i = 0; i < skus.length; i += batchSize) {
      const batch = skus.slice(i, i + batchSize);
      try {
        const skuParam = batch.join('%7C');
        const url = `${this.url}/ecomm-api/availability/products?skus=${skuParam}`;
        const raw = await this.stealthFetch(url, { headers: availHeaders, timeoutMs: 10000 });
        const data = JSON.parse(raw);

        if (!data.availabilities) continue;

        for (const avail of data.availabilities) {
          const product = products[avail.sku];
          if (!product) continue;

          const shippingPurchasable = avail.shipping?.purchasable === true;
          const pickupPurchasable = avail.pickup?.purchasable === true;
          const shippingStatus = avail.shipping?.status || '';

          product.inStock = shippingPurchasable || pickupPurchasable;
          product.canAddToCart = shippingPurchasable || pickupPurchasable;
          product.shipsToHome = shippingPurchasable;
          product.pickupAvailable = pickupPurchasable;
          product.availabilityStatus = shippingStatus;

          // Detect preorders
          if (shippingStatus === 'Preorder' || shippingStatus === 'ComingSoon') {
            product.isPreorderable = true;
          }
        }
      } catch (err) {
        logger.warn(`Best Buy: availability check failed for batch ${i}: ${err.message}`);
      }
    }
  }
}

module.exports = BestBuyAdapter;
