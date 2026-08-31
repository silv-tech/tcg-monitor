const logger = require('../monitoring/logger');
const { httpGet } = require('../utils/http');
const { stealthGet } = require('../utils/stealth-http');
const { getProxyUrl, getNextIspProxy, recordRequest, markProxyBlocked, markProxySuccess } = require('../core/proxy');
const productsConfig = require('../config/products.json');
const { classifyCategory, classifyProductType } = require('../utils/helpers');

let browserModule;
try { browserModule = require('../utils/browser'); } catch { browserModule = null; }

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

  getProxy() {
    // Returns { url, proxyObj } — proxyObj is the pool entry for ISP proxies (null otherwise)
    if (this.proxyTier === 'isp') {
      const proxyObj = getNextIspProxy(this.id);
      return { url: proxyObj ? proxyObj.url : null, proxyObj };
    }
    return { url: getProxyUrl(this.proxyTier, this.id), proxyObj: null };
  }

  _isProxyBlock(err) {
    const msg = err.message || '';
    return msg.includes('403') || msg.includes('503') || msg.includes('Blocked')
      || msg.includes('blocked') || msg.includes('CAPTCHA') || msg.includes('captcha')
      || msg.includes('Access Denied') || msg.includes('connection refused')
      || msg.includes('ECONNREFUSED') || msg.includes('socket hang up');
  }

  async fetch(url, opts = {}) {
    const { url: proxyUrl, proxyObj } = this.getProxy();
    const stickyKey = this.proxyTier === 'isp' ? this.id : null;
    try {
      const result = await httpGet(url, { ...opts, proxyUrl, stickyKey });
      recordRequest(this.id, false, this.proxyTier);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (err) {
      recordRequest(this.id, true, this.proxyTier);
      if (proxyObj && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
  }

  async stealthFetch(url, opts = {}) {
    const { url: proxyUrl, proxyObj } = this.getProxy();
    try {
      const result = await stealthGet(url, { ...opts, proxyUrl });
      recordRequest(this.id, false, this.proxyTier);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (err) {
      recordRequest(this.id, true, this.proxyTier);
      if (proxyObj && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
  }

  async browserFetch(url, opts = {}) {
    if (!browserModule) {
      throw new Error('Browser fallback unavailable — install playwright-core');
    }
    const { url: proxyUrl, proxyObj } = this.getProxy();
    try {
      const result = await browserModule.browserFetch(url, { ...opts, proxyUrl });
      recordRequest(this.id, false, this.proxyTier);
      if (proxyObj) markProxySuccess(proxyObj);
      return result;
    } catch (err) {
      recordRequest(this.id, true, this.proxyTier);
      if (proxyObj && this._isProxyBlock(err)) markProxyBlocked(proxyObj);
      throw err;
    }
  }

  classify(product) {
    product.category = classifyCategory(product.name, productsConfig.categories);
    product.productType = classifyProductType(product.name, productsConfig.productTypes);
    product.retailer = this.name;
    product.retailerId = this.id;
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
