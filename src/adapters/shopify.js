const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');

/**
 * Universal Shopify adapter — works for ANY Shopify store.
 * Shopify exposes /products.json and /collections/{handle}.json publicly.
 * One adapter instance per store, configured via retailers.json.
 */
class ShopifyAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    // Shopify-specific config from retailers.json
    this.collections = config.collections || []; // e.g. ['pokemon', 'trading-cards', 'new-arrivals']
    this.searchKeywords = config.searchKeywords || [];
    this.pageLimit = config.pageLimit || 250; // Shopify max per page
  }

  async fetchProducts() {
    const products = {};

    // Method 1: Fetch from specific collections
    for (const collection of this.collections) {
      try {
        await this.fetchCollection(collection, products);
      } catch (err) {
        logger.warn(`${this.name}: collection "${collection}" failed: ${err.message}`);
      }
    }

    // Method 2: Fetch all products (fallback if no collections configured)
    if (this.collections.length === 0) {
      try {
        await this.fetchAllProducts(products);
      } catch (err) {
        logger.warn(`${this.name}: /products.json failed: ${err.message}`);
      }
    }

    return products;
  }

  async fetchCollection(handle, products) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.url}/collections/${handle}/products.json?limit=${this.pageLimit}&page=${page}`;
      const data = await this.fetch(url, { json: true, timeoutMs: 15000 });

      if (!data.products || data.products.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of data.products) {
        this.parseShopifyProduct(item, products);
      }

      // Shopify returns empty array when no more pages
      hasMore = data.products.length === this.pageLimit;
      page++;

      // Safety: max 10 pages per collection
      if (page > 10) break;
    }
  }

  async fetchAllProducts(products) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.url}/products.json?limit=${this.pageLimit}&page=${page}`;
      const data = await this.fetch(url, { json: true, timeoutMs: 15000 });

      if (!data.products || data.products.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of data.products) {
        // Filter by keywords if configured
        if (this.searchKeywords.length > 0) {
          const text = `${item.title} ${item.product_type} ${item.tags?.join(' ')}`.toLowerCase();
          const match = this.searchKeywords.some(kw => text.includes(kw.toLowerCase()));
          if (!match) continue;
        }
        this.parseShopifyProduct(item, products);
      }

      hasMore = data.products.length === this.pageLimit;
      page++;
      if (page > 10) break;
    }
  }

  parseShopifyProduct(item, products) {
    // Each Shopify product can have multiple variants
    for (const variant of item.variants) {
      const inStock = variant.available === true;
      const sku = variant.sku || `${item.id}-${variant.id}`;
      const image = item.images?.[0]?.src || item.image?.src || '';

      let price = typeof variant.price === 'number'
        ? variant.price
        : normalizePrice(variant.price);

      // Some Shopify stores return prices in cents (e.g. 1999.00 = $19.99)
      // Heuristic: if price > 500, it's likely in cents
      if (price != null && price > 500) {
        price = price / 100;
      }

      const product = this.classify({
        sku,
        name: item.variants.length > 1
          ? `${item.title} - ${variant.title}`
          : item.title,
        price,
        currency: 'CAD',
        url: `${this.url}/products/${item.handle}`,
        image,
        inStock,
        canAddToCart: inStock,
        shipsToHome: true,
      });

      // Add Shopify-specific metadata
      product._variantId = variant.id;
      product._productId = item.id;
      product._tags = item.tags || [];
      product._vendor = item.vendor;

      products[product.sku] = product;
    }
  }

  /**
   * Fast stock check using only cart/add endpoint.
   * Returns true if the variant can be added to cart (in stock).
   * Useful for rapid polling of specific variants without fetching full product data.
   */
  async quickStockCheck(variantId) {
    try {
      const url = `${this.url}/cart/add.js`;
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: variantId, quantity: 1 }),
        json: true,
      });
      return true; // If we get here, it's in stock
    } catch (err) {
      // 422 = variant not available
      return false;
    }
  }
}

module.exports = ShopifyAdapter;
