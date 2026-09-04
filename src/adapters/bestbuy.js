const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { searchQueries: SEARCH_QUERIES } = require('../config/products.json');

// Best Buy's search API is the slow part — 7 queries take ~10s wall even fired in
// parallel — while the availability API answers for 10 SKUs in one fast call. So the
// two are split, exactly like Amazon: search occasionally to find new SKUs, and check
// stock on the known set every poll.
const DISCOVERY_INTERVAL_DEFAULT = 5 * 60 * 1000;
const DISCOVERY_INTERVAL_FLOOR = 60 * 1000;
const AVAILABILITY_BATCH = 10;

// Availability API rejects anything that does not look like the site's own XHR (412)
const AVAIL_HEADERS = {
  'Accept': 'application/vnd.bestbuy.standardproduct.v1+json',
  'sec-ch-ua': '"Google Chrome";v="127"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

class BestBuyAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.searchQueries = config.searchQueries || SEARCH_QUERIES;
    this.pageSize = 48;
    this.watchlist = new Set(config.watchlist || []);
    this._knownProducts = new Map(); // sku → classified product
    this._lastDiscoveryAt = 0;
    this._deriveTiming();
  }

  _deriveTiming() {
    this.discoveryIntervalMs = this.timingValue('discoveryIntervalMs', DISCOVERY_INTERVAL_DEFAULT, DISCOVERY_INTERVAL_FLOOR);
  }

  async fetchProducts() {
    const products = {};
    const now = Date.now();
    const needsDiscovery = now - this._lastDiscoveryAt >= this.discoveryIntervalMs
      || this._knownProducts.size === 0;

    if (needsDiscovery) {
      await this._runDiscovery();
      this._lastDiscoveryAt = now;
    }

    // Every poll: re-check stock on everything we know about. One batched call per
    // 10 SKUs, so this stays a fraction of a second even as the catalogue grows.
    const skus = [...this._knownProducts.keys()];
    if (skus.length === 0) return products;

    for (const [sku, product] of this._knownProducts) products[sku] = product;
    const updated = await this._checkAvailability(skus, products);
    this.reportFreshness(updated, skus.length);

    if (needsDiscovery) {
      logger.info(`Best Buy: DISCOVERY — ${this._knownProducts.size} known SKUs. Next in ${Math.round(this.discoveryIntervalMs / 60000)}min.`);
    }
    return products;
  }

  /** Slow path: search for SKUs we have not seen before. */
  async _runDiscovery() {
    const searches = await Promise.allSettled(this.searchQueries.map(query => {
      const searchUrl = `${this.url}/api/v2/json/search?query=${encodeURIComponent(query)}&lang=en-CA&pageSize=${this.pageSize}`;
      return this.fetch(searchUrl, { json: true, timeoutMs: 20000, maxRetries: 2 });
    }));

    let found = 0;
    searches.forEach((result, i) => {
      if (result.status === 'rejected') {
        logger.warn(`Best Buy: search failed for "${this.searchQueries[i]}": ${result.reason.message}`);
        return;
      }
      for (const item of result.value.products || []) {
        if (!item.sku || !item.name) continue;
        if (!item.isVisible) continue;
        // Sold by Best Buy only — the client does not want marketplace sellers
        if (item.isMarketplace) continue;

        const price = item.salePrice || item.regularPrice;
        this._knownProducts.set(item.sku, this.classify({
          sku: item.sku,
          name: item.name,
          price: typeof price === 'number' ? price : parseFloat(price) || 0,
          currency: 'CAD',
          url: `${this.url}${item.productUrl}`,
          image: item.highResImage || item.thumbnailImage || '',
          inStock: false, // availability check fills this in
          canAddToCart: false,
          isPreorderable: item.isPreorderable || false,
          isMarketplace: false,
          seller: item.seller?.name || 'Best Buy',
          isOnSale: item.salePrice < item.regularPrice,
          regularPrice: item.regularPrice,
          shipsToHome: !item.isInStoreOnly,
        }));
        found++;
      }
    });

    // Keep watchlisted SKUs alive even when no search query surfaces them
    for (const sku of this.watchlist) {
      if (!this._knownProducts.has(sku)) {
        this._knownProducts.set(sku, this.classify({
          sku, name: `Best Buy ${sku}`, price: 0, currency: 'CAD',
          url: `${this.url}/en-ca/product/${sku}`, image: '',
          inStock: false, canAddToCart: false, seller: 'Best Buy', shipsToHome: true,
        }));
      }
    }
    return found;
  }

  /**
   * Fast path: batched availability for known SKUs.
   * @returns {number} how many SKUs came back with live data
   */
  async _checkAvailability(skus, products) {
    let updated = 0;

    const batches = [];
    for (let i = 0; i < skus.length; i += AVAILABILITY_BATCH) {
      batches.push(skus.slice(i, i + AVAILABILITY_BATCH));
    }

    const results = await Promise.allSettled(batches.map(batch => {
      const url = `${this.url}/ecomm-api/availability/products?skus=${batch.join('%7C')}`;
      return this.stealthFetch(url, { headers: AVAIL_HEADERS, timeoutMs: 8000, maxRetries: 1 });
    }));

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        logger.warn(`Best Buy: availability batch ${i} failed: ${result.reason.message}`);
        return;
      }
      let data;
      try { data = JSON.parse(result.value); } catch { return; }
      if (!data.availabilities) return;

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
        if (shippingStatus === 'Preorder' || shippingStatus === 'ComingSoon') {
          product.isPreorderable = true;
        }
        product.lastSeen = Date.now();
        this._knownProducts.set(avail.sku, product);
        updated++;
      }
    });

    return updated;
  }

  /** Watchlist fast-poll: one SKU, one availability call. */
  async fetchProductPage(sku) {
    const id = String(sku);
    const known = this._knownProducts.get(id);
    const product = known || this.classify({
      sku: id, name: `Best Buy ${id}`, price: 0, currency: 'CAD',
      url: `${this.url}/en-ca/product/${id}`, image: '',
      inStock: false, canAddToCart: false, seller: 'Best Buy', shipsToHome: true,
    });

    const holder = { [id]: product };
    const updated = await this._checkAvailability([id], holder);
    if (updated === 0) return null;

    const fresh = holder[id];
    fresh._watchlist = true;
    return fresh;
  }
}

module.exports = BestBuyAdapter;
