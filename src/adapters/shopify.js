const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { stealthGet } = require('../utils/stealth-http');

// Shopify prices by the CALLER'S GEOGRAPHY. The app runs from Railway in Virginia, so these
// Canadian stores were quoting USD while we labelled the result CAD — measured on live stores:
//   zardocards    US 602.00  vs  CA 800.00   (-25%)
//   hobbiesville  US 600.00  vs  CA 829.95   (-28%)
//   kanzengames   US 117.90  vs  CA 159.95   (-26%)
// Every Shopify alert was understating the price by about a quarter. This cookie pins the
// storefront to Canada, verified from a US IP to return prices identical to a Canadian one.
// It is free — the alternative was routing every catalogue fetch through a Canadian proxy.
const CA_LOCALE_HEADERS = {
  'Cookie': 'localization=CA; cart_currency=CAD',
  'Accept-Language': 'en-CA,en;q=0.9',
};
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
    // Conditional-request state, keyed by page URL. Both survive across polls: the ETag is what
    // earns the 304, and the cached page is what lets us skip parsing when we get one.
    this._etags = new Map();
    this._pageCache = new Map();
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

    // Method 2: Fetch all products (fallback if no collections configured OR collections returned nothing)
    if (this.collections.length === 0 || Object.keys(products).length === 0) {
      try {
        await this.fetchAllProducts(products);
      } catch (err) {
        logger.warn(`${this.name}: /products.json failed: ${err.message}`);
      }
    }

    return products;
  }

  /**
   * Fetch one catalogue page, but only pay for it when it has actually changed.
   *
   * Shopify serves an ETag on products.json and honours If-None-Match. These shops were
   * pulling up to ten pages of up to 2MB on EVERY poll — hobbiesville alone is ~20MB a cycle —
   * which is what let 31 shops starve the big six once autotune sped them all up. A 304 costs
   * ~150ms and zero bytes, so an unchanged shop is now nearly free to check.
   *
   * @returns {{products: array, changed: boolean}}
   */
  async _fetchPage(url) {
    const etag = this._etags.get(url);
    const res = await stealthGet(url, {
      withResponse: true,
      rawHeaders: true,
      timeoutMs: 15000,
      maxRetries: 1,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        ...CA_LOCALE_HEADERS,
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
    });

    if (res.status === 304) {
      // Unchanged — reuse what this page gave us last time, parse nothing, transfer nothing.
      return { products: this._pageCache.get(url) || [], changed: false };
    }
    let data;
    try { data = JSON.parse(res.body); } catch { return { products: [], changed: false }; }
    const list = data.products || [];
    if (res.headers.etag) this._etags.set(url, res.headers.etag);
    this._pageCache.set(url, list);
    return { products: list, changed: true };
  }

  async fetchCollection(handle, products) {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `${this.url}/collections/${handle}/products.json?limit=${this.pageLimit}&page=${page}`;
      const data = { products: (await this._fetchPage(url)).products };

      if (!data.products || data.products.length === 0) {
        hasMore = false;
        break;
      }

      this._detectPriceUnit(data.products);

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
      const data = { products: (await this._fetchPage(url)).products };

      if (!data.products || data.products.length === 0) {
        hasMore = false;
        break;
      }

      // Judge the store's price unit on the UNFILTERED page — the keyword filter can leave
      // too few prices to read the distribution from.
      this._detectPriceUnit(data.products);

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

  /**
   * Decide once per poll whether this store quotes cents, from the whole batch rather than
   * one price. Sticky: a confident verdict is kept so a small or unusual page cannot flip it
   * mid-run and rewrite every price by 100x.
   */
  _detectPriceUnit(allProducts) {
    if (this._priceUnitLocked) return;
    const values = [];
    for (const item of allProducts || []) {
      for (const v of item.variants || []) {
        const n = Number(v.price);
        if (!isNaN(n) && n > 0) values.push(n);
      }
    }
    if (values.length < 25) return; // too thin to judge — leave the previous verdict alone
    const roundHundreds = values.filter((n) => n % 100 === 0).length;
    const ratio = roundHundreds / values.length;
    const cents = ratio >= 0.99;
    if (this._pricesAreCents !== cents) {
      logger.info(`${this.name}: prices detected as ${cents ? 'CENTS (dividing by 100)' : 'DOLLARS'} — ${roundHundreds}/${values.length} exact multiples of 100`);
    }
    this._pricesAreCents = cents;
    this._priceUnitLocked = true;
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

      // Some Shopify stores quote prices in cents. Deciding that PER PRICE is wrong in both
      // directions, and the old "divide anything over 5000" rule was measurably wrong on live
      // stores: hobbiesville quotes cents, so its $13.00 deck box (raw "1300.00") was reported
      // as $1,300, while kanzengames quotes dollars, so a genuine $10,000 listing would have
      // been divided down to $100.
      //
      // The unit is a property of the STORE, not of one price, and the distribution says so
      // unambiguously — measured over a full catalogue page:
      //   hobbiesville  696/696  prices are exact multiples of 100  -> cents
      //   zardocards   1192/1192 ->  cents
      //   kanzengames    30/638  ->  dollars
      //   vancitytcg      0/1460 ->  dollars
      // A dollars store always has some price ending in .95/.99; a cents store cannot.
      if (price != null && this._pricesAreCents) {
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
      product.stockCount = variant.inventory_quantity ?? null;

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
