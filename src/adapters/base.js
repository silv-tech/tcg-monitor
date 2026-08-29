const logger = require('../monitoring/logger');
const { httpGet } = require('../utils/http');
const { getProxyUrl, recordRequest } = require('../core/proxy');
const productsConfig = require('../config/products.json');
const { classifyCategory, classifyProductType } = require('../utils/helpers');

class BaseAdapter {
  constructor(retailerConfig) {
    this.id = retailerConfig.id;
    this.name = retailerConfig.name;
    this.url = retailerConfig.url;
    this.intervalMs = retailerConfig.intervalMs;
    this.proxyTier = retailerConfig.proxyTier;
    this.color = retailerConfig.color;
    this.enabled = retailerConfig.enabled;
  }

  getProxyUrl() {
    return getProxyUrl(this.proxyTier);
  }

  async fetch(url, opts = {}) {
    const proxyUrl = this.getProxyUrl();
    try {
      const result = await httpGet(url, { ...opts, proxyUrl });
      recordRequest(this.id, false);
      return result;
    } catch (err) {
      recordRequest(this.id, true);
      throw err;
    }
  }

  classify(product) {
    product.category = classifyCategory(product.name, productsConfig.categories);
    product.productType = classifyProductType(product.name, productsConfig.productTypes);
    product.retailer = this.name;
    product.lastSeen = Date.now();
    return product;
  }

  async fetchProducts() {
    throw new Error(`${this.id}: fetchProducts() not implemented`);
  }

  async run() {
    logger.info(`Polling ${this.name}...`);
    const start = Date.now();
    try {
      const products = await this.fetchProducts();
      const elapsed = Date.now() - start;
      logger.info(`${this.name}: found ${Object.keys(products).length} products in ${elapsed}ms`);
      return products;
    } catch (err) {
      const elapsed = Date.now() - start;
      logger.error(`${this.name}: poll failed in ${elapsed}ms`, { error: err.message });
      throw err;
    }
  }
}

module.exports = BaseAdapter;
