const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { walmartProductLookup } = require('../utils/scraper-api');
const { getProxyUrl } = require('../core/proxy');
const { stealthGet, _clearCache } = require('../utils/stealth-http');

class WalmartAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.walmart.ca';
    this.watchlist = new Set(config.watchlist || []);
    // Search queries for ScraperAPI structured endpoint
    this.searchQueries = [
      'pokemon tcg',
      'pokemon booster box',
      'pokemon elite trainer box',
      'pokemon tcg collection',
      'pokemon tin sealed',
      'tcg booster box',
      'pokemon scarlet violet',
    ];
    // Staggered groups — alternate each cycle for continuous coverage
    this._queryGroups = [
      this.searchQueries.slice(0, 4),  // Group A
      this.searchQueries.slice(4),     // Group B
    ];
    this._groupIndex = 0;
    this._polling = false; // overlap guard
  }

  /**
   * Fetch a single product page by Walmart SKU/product ID.
   * Hybrid approach for near-100% success + minimal cost:
   *  1. Try stealth HTTP + residential proxy (FREE, ~60-70% success)
   *  2. On challenge, fall back to ScraperAPI (5 credits, 100% success)
   * Saves 60-70% of ScraperAPI costs vs pure ScraperAPI polling.
   */
  async fetchProductPage(productId) {
    const url = `https://www.walmart.ca/ip/${productId}`;
    const proxyUrl = getProxyUrl('residential');
    const start = Date.now();

    // Stealth first (free, ~2-4s). Only fire ScraperAPI if stealth can't parse the page.
    const stealth = await this._stealthFetchProduct(url, productId, proxyUrl);

    if (stealth.product) {
      const product = stealth.product;
      product._watchlist = true;
      logger.info(`Walmart: WATCHLIST ${productId} — "${product.name}" | inStock=${product.inStock} | $${product.price || '?'} | ${Date.now() - start}ms (stealth)`);
      return product;
    }

    if (stealth.thirdParty) {
      // Stealth confirmed third-party — no Walmart offer, skip ScraperAPI (saves 5 credits)
      return null;
    }

    // Stealth failed (challenge/blocked) — fall back to ScraperAPI (5 credits)
    const scraper = await this._scraperFetchProduct(productId, url);

    if (scraper.product) {
      const product = scraper.product;
      product._watchlist = true;
      logger.info(`Walmart: WATCHLIST ${productId} — "${product.name}" | inStock=${product.inStock} | $${product.price || '?'} | ${Date.now() - start}ms (scraper fallback)`);
      return product;
    }

    if (scraper.thirdParty) return null;

    logger.warn(`Walmart: WATCHLIST ${productId} — both methods failed (${Date.now() - start}ms)`);
    return null;
  }

  /**
   * Stealth fetch a product page (free, ~2-4s).
   * Returns { product, thirdParty } or throws.
   */
  async _stealthFetchProduct(url, productId, proxyUrl) {
    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 6000,
      });

      if (html && html.length > 500 && !html.includes('Verify Your Identity')) {
        const product = this._parseProductPage(html, productId);
        if (product) return { product, thirdParty: false };
        // Page parsed but no Walmart offer = third-party seller
        if (html.includes('application/ld+json') || html.includes('__NEXT_DATA__')) {
          return { product: null, thirdParty: true };
        }
      }
      if (proxyUrl) _clearCache(proxyUrl);
      return { product: null, thirdParty: false };
    } catch {
      if (proxyUrl) _clearCache(proxyUrl);
      return { product: null, thirdParty: false };
    }
  }

  /**
   * ScraperAPI fetch a product page (5 credits, ~3-8s).
   * Returns { product, thirdParty } or throws.
   */
  async _scraperFetchProduct(productId, url) {
    try {
      const data = await walmartProductLookup(productId, { retailerId: this.id });
      if (!data) return { product: null, thirdParty: false };

      const name = data.product_name || data.name || data.title;
      if (!name) return { product: null, thirdParty: false };

      // Check seller — only accept Walmart's own offers
      const dataSeller = (data.seller || data.sold_by || '').toLowerCase();
      if (dataSeller && !dataSeller.includes('walmart')) {
        logger.info(`Walmart: WATCHLIST ${productId} — third-party: "${data.seller || data.sold_by}" (scraper)`);
        return { product: null, thirdParty: true };
      }

      if (data.offers && Array.isArray(data.offers)) {
        const hasWalmartOffer = data.offers.some(o => {
          const s = (o.seller?.name || o.seller || o.sold_by || '').toString().toLowerCase();
          return !s || s.includes('walmart');
        });
        if (!hasWalmartOffer) {
          return { product: null, thirdParty: true };
        }
      }

      let price = null;
      if (data.offers && Array.isArray(data.offers)) {
        for (const offer of data.offers) {
          const s = (offer.seller?.name || offer.seller || offer.sold_by || '').toString().toLowerCase();
          if (!s || s.includes('walmart')) {
            price = typeof offer.price === 'number' ? offer.price :
              normalizePrice(offer.price_string || offer.price);
            break;
          }
        }
      }
      if (price == null) {
        price = typeof data.price === 'number' ? data.price :
          normalizePrice(data.price_string || data.price || data.product_price);
      }

      let inStock = null;
      if (data.offers && Array.isArray(data.offers)) {
        for (const offer of data.offers) {
          const s = (offer.seller?.name || offer.seller || offer.sold_by || '').toString().toLowerCase();
          if (s && !s.includes('walmart')) continue;
          const avail = (offer.availability || '').toLowerCase();
          if (avail.includes('instock') || avail.includes('in stock') || avail.includes('in_stock')) {
            inStock = true;
            break;
          }
          if (avail.includes('outofstock') || avail.includes('out of stock')) {
            inStock = false;
          }
        }
      } else {
        const avail = (data.availability || data.stock_status || '').toLowerCase();
        if (avail.includes('instock') || avail.includes('in stock')) inStock = true;
        else if (avail.includes('outofstock') || avail.includes('out of stock')) inStock = false;
      }

      if (inStock === null) {
        const state = require('../core/state');
        const oldProducts = await state.getAllProducts(this.id);
        const old = oldProducts[String(productId)];
        inStock = old ? old.inStock : false;
      }

      const image = data.image || data.product_image || data.thumbnail || '';
      const productUrl = data.url || data.product_url || url;

      const product = this.classify({
        sku: String(productId),
        name,
        price: price || 0,
        currency: 'CAD',
        url: productUrl,
        image,
        inStock,
        canAddToCart: inStock,
        shipsToHome: true,
      });

      if (data.offers && Array.isArray(data.offers)) {
        for (const offer of data.offers) {
          const s = (offer.seller?.name || offer.seller || offer.sold_by || '').toString().toLowerCase();
          if ((!s || s.includes('walmart')) && offer.offerId) {
            product._offerId = offer.offerId;
            break;
          }
        }
      }
      if (!product._offerId && data.offerId) {
        product._offerId = data.offerId;
      }

      return { product, thirdParty: false };
    } catch {
      return { product: null, thirdParty: false };
    }
  }

  /**
   * Parse Walmart product page HTML for JSON-LD structured data.
   * Walmart embeds a <script type="application/ld+json"> with Product schema.
   */
  _parseProductPage(html, productId) {
    // Method 1: __NEXT_DATA__ (preferred — has offerId for marketplace identification)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const product = this._parseNextData(nextData, productId);
        if (product) return product;
      } catch (e) {
        logger.debug(`Walmart: __NEXT_DATA__ parse failed for ${productId}: ${e.message}`);
      }
    }

    // Method 2: JSON-LD fallback (no offerId available here)
    let idx = 0;
    while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
      const start = html.indexOf('>', idx) + 1;
      const end = html.indexOf('</script>', start);
      if (end === -1) break;

      try {
        const json = JSON.parse(html.substring(start, end).trim());
        const productData = json['@type'] === 'Product' ? json :
          (Array.isArray(json) ? json.find(j => j['@type'] === 'Product') : null);

        if (productData) {
          return this._buildProduct(productData, productId);
        }
      } catch (e) {
        // skip malformed JSON-LD blocks
      }
      idx = end;
    }

    return null;
  }

  /**
   * Build classified product from JSON-LD Product schema.
   * Only considers offers sold by Walmart — third-party sellers are ignored.
   */
  _buildProduct(data, productId) {
    const name = data.name;
    if (!name) return null;

    const offers = data.offers;
    let price = null;
    let inStock = false;
    let seller = null;

    if (offers) {
      // offers can be a single object or array
      const offerList = Array.isArray(offers) ? offers : [offers];

      // First pass: find Walmart's own offer
      let walmartOffer = null;
      for (const offer of offerList) {
        const sellerName = (offer.seller?.name || offer.seller || '').toString().toLowerCase();
        if (sellerName.includes('walmart')) {
          walmartOffer = offer;
          seller = offer.seller?.name || offer.seller || 'Walmart';
          break;
        }
      }

      // If no Walmart offer found, log all sellers and skip
      if (!walmartOffer) {
        const sellers = offerList.map(o => o.seller?.name || o.seller || 'unknown').join(', ');
        logger.info(`Walmart: WATCHLIST ${productId} — skipping third-party sellers: ${sellers}`);
        return null;
      }

      // Use Walmart's offer for price/stock
      if (walmartOffer.price != null) {
        price = typeof walmartOffer.price === 'number' ? walmartOffer.price : normalizePrice(String(walmartOffer.price));
      }
      const avail = (walmartOffer.availability || '').toLowerCase();
      if (avail.includes('instock')) {
        inStock = true;
      }
    }

    const image = typeof data.image === 'string' ? data.image :
      (Array.isArray(data.image) ? data.image[0] : (data.image?.url || ''));

    return this.classify({
      sku: data.sku || String(productId),
      name,
      price: price || 0,
      currency: 'CAD',
      url: data.url || `https://www.walmart.ca/ip/${productId}`,
      image,
      inStock,
      canAddToCart: inStock,
      shipsToHome: true,
    });
  }

  /**
   * Parse __NEXT_DATA__ for product info (fallback if no JSON-LD).
   * Only considers Walmart's own offers.
   */
  _parseNextData(nextData, productId) {
    try {
      // Navigate Next.js data structure — Walmart puts product data in props
      const props = nextData?.props?.pageProps;
      if (!props) return null;

      // Look for product data in various locations
      const item = props.product || props.item || props.initialData?.data?.product;
      if (!item || !item.name) return null;

      // Check seller — skip third-party
      const sellerName = (item.seller || item.sellerName || item.soldBy || item.sellerDisplayName || '').toLowerCase();
      if (sellerName && !sellerName.includes('walmart')) {
        logger.info(`Walmart: WATCHLIST ${productId} — skipping third-party seller: "${item.seller || item.sellerName || item.soldBy || item.sellerDisplayName}" (nextData)`);
        return null;
      }

      // Extract offerId — 32-char hex string unique to this seller's offer
      // Check root level first, then buyBox.products[0] (Buy Box winner)
      const offerId = item.offerId
        || item.buyBox?.products?.[0]?.offerId
        || null;

      const price = item.price?.currentPrice || item.priceInfo?.currentPrice?.price;
      const avail = (item.availabilityStatus || item.availability || '').toLowerCase();
      const inStock = avail.includes('in_stock') || avail.includes('available');

      const product = this.classify({
        sku: item.usItemId || item.id || String(productId),
        name: item.name,
        price: price || 0,
        currency: 'CAD',
        url: `https://www.walmart.ca/ip/${productId}`,
        image: item.imageInfo?.thumbnailUrl || item.image || '',
        inStock,
        canAddToCart: inStock,
        shipsToHome: true,
      });

      // Attach offerId outside classify() — it's metadata, not a standard product field
      if (offerId) {
        product._offerId = offerId;
        logger.debug(`Walmart: ${productId} offerId=${offerId}`);
      }

      // Extract stock quantity from buyBox or item-level data
      const qty = item.buyBox?.products?.[0]?.maxQuantity
        || item.buyBox?.products?.[0]?.availableQuantity
        || item.maxQuantity
        || item.availableQuantity
        || null;
      if (qty != null) {
        product._stockQty = qty;
      }

      return product;
    } catch {
      return null;
    }
  }

  /**
   * Stealth-fetch a Walmart search page and parse __NEXT_DATA__ for results.
   * Returns array of product items (same shape as ScraperAPI) or null on failure.
   */
  async _stealthSearch(query) {
    const url = `https://www.walmart.ca/search?q=${encodeURIComponent(query)}`;
    const proxyUrl = getProxyUrl('residential');

    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 8000,
      });

      if (!html || html.length < 500 || html.includes('Verify Your Identity')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      // Parse __NEXT_DATA__ — Walmart search results live here
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const searchData = nextData?.props?.pageProps?.initialData?.searchResult?.itemStacks?.[0]?.items
            || nextData?.props?.pageProps?.searchResult?.itemStacks?.[0]?.items
            || nextData?.props?.pageProps?.items
            || [];

          if (searchData.length > 0) {
            // Normalize to same shape the adapter expects
            return searchData.map(item => ({
              name: item.name || item.title,
              id: item.usItemId || item.id || item.productId,
              price: item.price || item.priceInfo?.currentPrice?.price,
              seller: item.sellerName || item.seller || item.soldBy || '',
              fulfillmentType: item.fulfillmentType || item.fulfillment?.type || '',
              sellerDisplayName: item.sellerDisplayName || '',
              url: item.canonicalUrl || item.url || '',
              image: item.imageInfo?.thumbnailUrl || item.image || item.thumbnail || '',
              availability: item.availabilityStatusV2?.value || item.availabilityStatus || '',
              offerId: item.offerId || item.buyBoxSuppression?.offerId || '',
            })).filter(i => i.name);
          }
        } catch {
          // JSON parse failed
        }
      }

      // Fallback: parse JSON-LD from search page
      let idx = 0;
      const items = [];
      while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
        const start = html.indexOf('>', idx) + 1;
        const end = html.indexOf('</script>', start);
        if (end === -1) break;
        try {
          const json = JSON.parse(html.substring(start, end).trim());
          // ItemList schema from search
          if (json['@type'] === 'ItemList' && json.itemListElement) {
            for (const elem of json.itemListElement) {
              const prod = elem.item || elem;
              if (prod.name) {
                items.push({
                  name: prod.name,
                  id: prod.sku || prod.productID,
                  price: prod.offers?.price,
                  seller: prod.offers?.seller?.name || '',
                  fulfillmentType: '',
                  url: prod.url || '',
                  image: typeof prod.image === 'string' ? prod.image : '',
                  availability: prod.offers?.availability || '',
                });
              }
            }
          }
        } catch { /* skip */ }
        idx = end;
      }
      if (items.length > 0) return items;

      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    } catch {
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  async fetchProducts() {
    // Overlap guard — if previous cycle is still running, skip
    if (this._polling) {
      logger.debug('Walmart: skipping fetchProducts — previous cycle still running');
      return {};
    }
    this._polling = true;

    try {
      const products = {};

      // Staggered groups: alternate A/B each cycle for continuous coverage
      // Group A fires on even cycles, Group B on odd — every 5s one group runs
      const group = this._queryGroups[this._groupIndex % this._queryGroups.length];
      const groupLabel = this._groupIndex % this._queryGroups.length === 0 ? 'A' : 'B';
      this._groupIndex++;

      // Pass 1: all queries in parallel
      const start = Date.now();
      const results = await Promise.allSettled(
        group.map(query =>
          this._stealthSearch(query).then(items => ({ query, items }))
        )
      );

      let hits = 0;
      const failedQueries = [];
      for (const [i, result] of results.entries()) {
        if (result.status === 'rejected') { failedQueries.push(group[i]); continue; }
        const { query, items } = result.value;
        if (!items || items.length === 0) { failedQueries.push(query); continue; }
        hits++;
        this._processSearchItems(items, products);
      }

      // Pass 2: retry failed queries on a fresh IP
      if (failedQueries.length > 0) {
        _clearCache(getProxyUrl('residential'));
        const retryResults = await Promise.allSettled(
          failedQueries.map(query =>
            this._stealthSearch(query).then(items => ({ query, items }))
          )
        );
        for (const result of retryResults) {
          if (result.status === 'rejected') continue;
          const { items } = result.value;
          if (!items || items.length === 0) continue;
          hits++;
          this._processSearchItems(items, products);
        }
      }

      const elapsed = Date.now() - start;
      logger.info(`Walmart: group ${groupLabel} — ${hits}/${group.length} stealth${failedQueries.length > 0 ? ` (${failedQueries.length} retried)` : ''}, ${Object.keys(products).length} products, ${elapsed}ms ($0)`);

      return products;
    } finally {
      this._polling = false;
    }
  }

  /**
   * Process search result items into classified products.
   * Shared by both stealth and ScraperAPI search paths.
   */
  _processSearchItems(items, products) {
    let skippedSeller = 0;
    let skippedFulfillment = 0;
    let skippedUnknown = 0;

    for (const item of items) {
      try {
        if (!item.name && !item.title) continue;
        const name = item.name || item.title;

        // STRICT seller filter — only Walmart-sold items (#9)
        const seller = (item.seller || item.sold_by || item.sellerName || item.sellerDisplayName || '').toLowerCase();
        const fulfillment = (item.fulfillmentType || item.fulfillment_type || '').toUpperCase();

        // Explicit third-party seller → always skip
        if (seller && !seller.includes('walmart')) {
          skippedSeller++;
          continue;
        }

        // If fulfillment type says marketplace → skip
        if (fulfillment === 'MP' || fulfillment === 'MARKETPLACE') {
          skippedFulfillment++;
          continue;
        }

        // Positively confirmed Walmart: seller says walmart OR fulfillment says FC/FFC
        const confirmedWalmart = seller.includes('walmart') ||
          fulfillment === 'FC' || fulfillment === 'FFC';

        // If we can't confirm it's Walmart-sold → skip (better to miss than send third-party alert)
        if (!confirmedWalmart) {
          skippedUnknown++;
          continue;
        }

        const sku = item.id || item.product_id || item.us_item_id || item.usItemId ||
          name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

        const price = typeof item.price === 'number' ? item.price :
          normalizePrice(item.price_string || item.price);

        const url = item.url || item.product_url || item.link || item.canonicalUrl ||
          `${this.url}/ip/${sku}`;
        const fullUrl = url.startsWith('http') ? url : `${this.url}${url}`;

        const image = item.image || item.thumbnail || '';
        const avail = (item.availability || item.availabilityStatus || '').toLowerCase();
        const inStock = avail ? avail.includes('in stock') || avail.includes('instock') || avail.includes('in_stock') : false;

        const product = this.classify({
          sku: String(sku),
          name,
          price,
          currency: 'CAD',
          url: fullUrl,
          image,
          inStock,
          canAddToCart: inStock,
          shipsToHome: true,
        });

        // Attach offerId if available from search results
        if (item.offerId) {
          product._offerId = item.offerId;
        }

        products[product.sku] = product;
      } catch (err) {
        logger.debug(`Walmart: failed to parse item: ${err.message}`);
      }
    }

    if (skippedSeller + skippedFulfillment + skippedUnknown > 0) {
      logger.info(`Walmart: seller filter — skipped ${skippedSeller} third-party, ${skippedFulfillment} marketplace, ${skippedUnknown} unconfirmed`);
    }
  }
}

module.exports = WalmartAdapter;
