const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, sleep } = require('../utils/helpers');
const { walmartSearch, walmartProductLookup, isConfigured } = require('../utils/scraper-api');
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
    ];
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

    // Step 1: Try free stealth fetch
    let stealthParsed = false; // true if page was parseable (even if third-party seller)
    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 12000,
      });

      if (html && html.length > 500 && !html.includes('Verify Your Identity')) {
        const product = this._parseProductPage(html, productId);
        if (product) {
          product._watchlist = true;
          logger.info(`Walmart: WATCHLIST ${productId} — "${product.name}" | inStock=${product.inStock} | $${product.price || '?'} (stealth)`);
          return product;
        }
        // If _parseProductPage returned null, it could be:
        // a) third-party seller (logged inside _buildProduct) — don't waste credits on ScraperAPI
        // b) unparseable page — fall through to ScraperAPI
        // Check if JSON-LD was found (third-party) vs truly unparseable
        if (html.includes('application/ld+json') || html.includes('__NEXT_DATA__')) {
          stealthParsed = true; // page had data, just not a Walmart offer
        }
      }

      // Challenge page or unparseable — rotate IP for next attempt
      if (proxyUrl) _clearCache(proxyUrl);
    } catch {
      // Stealth failed — rotate IP
      if (proxyUrl) _clearCache(proxyUrl);
    }

    // Skip ScraperAPI if stealth confirmed it's a third-party seller — saves 5 credits
    if (stealthParsed) return null;

    // Step 2: Fall back to ScraperAPI (5 credits, reliable)
    try {
      const data = await walmartProductLookup(productId, { retailerId: this.id });
      if (!data) return null; // rate-limited or 404

      const name = data.product_name || data.name || data.title;
      if (!name) return null;

      // Check seller — only accept Walmart's own offers
      const dataSeller = (data.seller || data.sold_by || '').toLowerCase();
      if (dataSeller && !dataSeller.includes('walmart')) {
        logger.info(`Walmart: WATCHLIST ${productId} — skipping third-party seller: "${data.seller || data.sold_by}" (scraper)`);
        return null;
      }

      // Check offers array for seller info too
      if (data.offers && Array.isArray(data.offers)) {
        const hasWalmartOffer = data.offers.some(o => {
          const s = (o.seller?.name || o.seller || o.sold_by || '').toString().toLowerCase();
          return !s || s.includes('walmart');
        });
        if (!hasWalmartOffer) {
          const sellers = data.offers.map(o => o.seller?.name || o.seller || o.sold_by || 'unknown').join(', ');
          logger.info(`Walmart: WATCHLIST ${productId} — skipping third-party sellers: ${sellers} (scraper)`);
          return null;
        }
      }

      let price = null;
      // Try to get price from Walmart's offer specifically
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

      // ScraperAPI autoparse doesn't reliably report Walmart CA stock status.
      // Only trust explicit InStock — don't let missing availability override
      // a stealth-confirmed inStock=true (prevents false RESTOCK flip-flops).
      let inStock = null; // null = unknown
      if (data.offers && Array.isArray(data.offers)) {
        for (const offer of data.offers) {
          const s = (offer.seller?.name || offer.seller || offer.sold_by || '').toString().toLowerCase();
          if (s && !s.includes('walmart')) continue; // skip third-party offers
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

      // If ScraperAPI can't determine stock, keep last known value from Redis
      if (inStock === null) {
        const state = require('../core/state');
        const oldProducts = await state.getAllProducts(this.id);
        const old = oldProducts[String(productId)];
        inStock = old ? old.inStock : false;
        logger.info(`Walmart: WATCHLIST ${productId} — ScraperAPI stock unknown, keeping last known: inStock=${inStock}`);
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
      product._watchlist = true;

      // Extract offerId from ScraperAPI offers if available
      if (data.offers && Array.isArray(data.offers)) {
        for (const offer of data.offers) {
          const s = (offer.seller?.name || offer.seller || offer.sold_by || '').toString().toLowerCase();
          if ((!s || s.includes('walmart')) && offer.offerId) {
            product._offerId = offer.offerId;
            break;
          }
        }
      }
      // Also check root-level offerId
      if (!product._offerId && data.offerId) {
        product._offerId = data.offerId;
      }

      logger.info(`Walmart: WATCHLIST ${productId} — "${name}" | inStock=${inStock} | $${price || '?'} | offerId=${product._offerId || 'none'} (scraper fallback)`);
      return product;
    } catch (err) {
      logger.warn(`Walmart: watchlist ${productId} — both methods failed: ${err.message}`);
      return null;
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
        timeoutMs: 15000,
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
    const products = {};

    // Hybrid search: stealth first (free), ScraperAPI fallback (5 credits each)
    const proxyUrl = getProxyUrl('residential');
    const failedQueries = []; // queries that need ScraperAPI fallback
    let stealthHits = 0;

    // Step 1: Try queries via stealth (free) — batches of 4 with jitter to avoid rate limiting
    const BATCH_SIZE = 4;
    for (let i = 0; i < this.searchQueries.length; i += BATCH_SIZE) {
      const batch = this.searchQueries.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(query =>
          this._stealthSearch(query).then(items => ({ query, items }))
        )
      );

      for (const result of batchResults) {
        if (result.status === 'rejected') {
          failedQueries.push(result.reason?.query || 'unknown');
          continue;
        }
        const { query, items } = result.value;
        if (!items || items.length === 0) {
          failedQueries.push(query);
          continue;
        }

        stealthHits++;
        this._processSearchItems(items, products);
        logger.info(`Walmart: "${query}" — ${items.length} results (stealth, free)`);
      }

      // Rotate IP + delay between batches to avoid Walmart flagging the same IP
      if (i + BATCH_SIZE < this.searchQueries.length) {
        const proxyUrl = getProxyUrl('residential');
        if (proxyUrl) _clearCache(proxyUrl);
        await sleep(1500 + Math.floor(Math.random() * 1500)); // 1.5-3s jitter
      }
    }

    // Step 1.5: Retry failed queries with fresh IPs (free) before burning ScraperAPI credits
    if (failedQueries.length > 0) {
      const retryQueries = [...failedQueries];
      failedQueries.length = 0; // clear for second pass

      // Rotate to fresh IP for retries
      const retryProxy = getProxyUrl('residential');
      if (retryProxy) _clearCache(retryProxy);
      await sleep(2000 + Math.floor(Math.random() * 2000)); // 2-4s cool-off

      // Retry in smaller batches of 2 with more jitter
      const RETRY_BATCH = 2;
      for (let i = 0; i < retryQueries.length; i += RETRY_BATCH) {
        const batch = retryQueries.slice(i, i + RETRY_BATCH);
        const retryResults = await Promise.allSettled(
          batch.map(query =>
            this._stealthSearch(query).then(items => ({ query, items }))
          )
        );

        for (const result of retryResults) {
          if (result.status === 'rejected') {
            failedQueries.push(result.reason?.query || 'unknown');
            continue;
          }
          const { query, items } = result.value;
          if (!items || items.length === 0) {
            failedQueries.push(query);
            continue;
          }

          stealthHits++;
          this._processSearchItems(items, products);
          logger.info(`Walmart: "${query}" — ${items.length} results (stealth retry, free)`);
        }

        if (i + RETRY_BATCH < retryQueries.length) {
          const px = getProxyUrl('residential');
          if (px) _clearCache(px);
          await sleep(1500 + Math.floor(Math.random() * 1500));
        }
      }
    }

    // Step 2: ScraperAPI fallback for queries that failed both stealth passes
    if (failedQueries.length > 0 && isConfigured()) {
      const scraperResults = await Promise.allSettled(
        failedQueries.map(query =>
          walmartSearch(query, { tld: 'ca', retailerId: this.id })
            .then(data => ({ query, data }))
        )
      );

      for (const result of scraperResults) {
        if (result.status === 'rejected') {
          logger.warn(`Walmart: search failed: ${result.reason.message}`);
          continue;
        }
        const { query, data } = result.value;
        if (!data) continue;

        const results = data.items || data.results || data.search_results || [];
        if (results.length === 0) continue;

        this._processSearchItems(results, products);
        logger.info(`Walmart: "${query}" — ${results.length} results (scraper fallback, 5 credits)`);
      }
    }

    logger.info(`Walmart: ${stealthHits}/${this.searchQueries.length} queries free (stealth), ${failedQueries.length} used ScraperAPI. ${Object.keys(products).length} total products.`);

    return products;
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
