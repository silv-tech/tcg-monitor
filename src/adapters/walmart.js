const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { getProxyUrl } = require('../core/proxy');
const { stealthGet, _clearCache } = require('../utils/stealth-http');
const state = require('../core/state');
const { hashSku } = require('../utils/helpers');

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
   * Fetch Walmart's own offer for a product id. A proxied and a direct stealth fetch race and the
   * first parsed page wins. No ScraperAPI here: it only returns the buy-box winner, and awaiting it
   * cost 15-60s of blindness after every stealth miss during the Prismatic drop.
   */
  async fetchProductPage(productId) {
    // selectedSellerId=0 pins Walmart's own offer — the plain page only shows the buy-box winner,
    // which lagged ~70s behind Walmart's offer going live during the Prismatic drop
    const url = `https://www.walmart.ca/ip/${productId}?selectedSellerId=0`;
    const start = Date.now();

    const result = await this._raceParsed([
      this._stealthFetchProduct(url, productId, getProxyUrl('residential')).then(r => ({ ...r, via: 'proxy' })),
      this._stealthFetchProduct(url, productId, null).then(r => ({ ...r, via: 'direct' })),
    ]);

    if (result.product) {
      const product = result.product;
      product._watchlist = true;
      logger.info(`Walmart: WATCHLIST ${productId} — "${product.name}" | inStock=${product.inStock} | $${product.price || '?'} | ${Date.now() - start}ms (${result.via})`);
      return product;
    }
    if (result.thirdParty) return null;

    logger.warn(`Walmart: WATCHLIST ${productId} — stealth failed on both paths (${Date.now() - start}ms)`);
    return null;
  }

  // Resolves with the first attempt that parsed a page (a product, or a confirmed third-party page)
  _raceParsed(attempts) {
    return new Promise(resolve => {
      let pending = attempts.length;
      let settled = false;
      for (const attempt of attempts) {
        attempt.catch(() => ({ product: null, thirdParty: false })).then(r => {
          if (settled) return;
          if (r.product || r.thirdParty) {
            settled = true;
            resolve(r);
          } else if (--pending === 0) {
            settled = true;
            resolve({ product: null, thirdParty: false });
          }
        });
      }
    });
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
      if (item.orderLimit > 0) {
        product._cartLimit = item.orderLimit;
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

      // Pass 1: all queries in parallel — results returned IMMEDIATELY for alerting
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

      const elapsed = Date.now() - start;
      logger.info(`Walmart: group ${groupLabel} — ${hits}/${group.length} stealth, ${Object.keys(products).length} products, ${elapsed}ms ($0)`);

      // Pass 2 (background): retry failed queries on a fresh IP.
      // Runs AFTER pass-1 products are returned for immediate alerting.
      // Recovered products are saved directly to Redis so they appear in the next diff.
      if (failedQueries.length > 0) {
        this._retryInBackground(failedQueries, groupLabel);
      }

      return products;
    } finally {
      this._polling = false;
    }
  }

  /**
   * Background retry: recover failed queries on a fresh IP and save to Redis.
   * Fire-and-forget — never blocks pass-1 alerting.
   */
  _retryInBackground(failedQueries, groupLabel) {
    setImmediate(async () => {
      try {
        _clearCache(getProxyUrl('residential'));
        const retryResults = await Promise.allSettled(
          failedQueries.map(query =>
            this._stealthSearch(query).then(items => ({ query, items }))
          )
        );

        const recovered = {};
        let retryHits = 0;
        for (const result of retryResults) {
          if (result.status === 'rejected') continue;
          const { items } = result.value;
          if (!items || items.length === 0) continue;
          retryHits++;
          this._processSearchItems(items, recovered);
        }

        // Save recovered products directly to Redis state for next diff cycle
        const entries = Object.entries(recovered);
        if (entries.length > 0) {
          const pipeline = state.getRedis().pipeline();
          for (const [sku, product] of entries) {
            const key = `tcg:product:${hashSku(this.id, sku)}`;
            pipeline.set(key, JSON.stringify(product), 'EX', 86400 * 7);
          }
          await pipeline.exec();
        }

        logger.info(`Walmart: group ${groupLabel} retry — ${retryHits}/${failedQueries.length} recovered, ${entries.length} products saved to Redis`);
      } catch (err) {
        logger.warn(`Walmart: background retry error: ${err.message}`);
      }
    });
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
