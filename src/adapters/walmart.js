const crypto = require('crypto');
const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { getProxyUrl } = require('../core/proxy');
const { stealthGet, _clearCache } = require('../utils/stealth-http');
const state = require('../core/state');
const { hashSku } = require('../utils/helpers');

// Persisted-query hash and platform version of the product page's DynamicItemById call.
// Both rotate with walmart.ca deploys — override via env when the JSON leg starts logging rejections.
const DYNAMIC_ITEM_HASH = process.env.WALMART_DYNAMIC_ITEM_HASH
  || '9ffbc1ef35327cf00cba1825ff8acaccc03b18a6d1d514d346ea06a786b30c8e';
const WALMART_PLATFORM_VERSION = process.env.WALMART_PLATFORM_VERSION
  || 'caweb-1.173.1-c25ee44a95e7802fdc2073b775d1044335bb50e0-8311154r';

class WalmartAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.walmart.ca';
    this.watchlist = new Set(config.watchlist || []);
    // Four broad queries, all run every cycle. Seven queries split into alternating
    // groups meant each term was only searched every 16s; these four overlap enough to
    // cover the same catalogue at the same request rate, so every term is seen every 8s.
    this.searchQueries = config.searchQueries || [
      'pokemon tcg',
      'pokemon booster box',
      'pokemon elite trainer box',
      'one piece card game',
    ];
    this._groupIndex = 0;
    this._polling = false; // overlap guard
    this._walmartOfferIds = new Map(); // product id → Walmart's own offerId (learned from the pinned page)
    this._lastPageProduct = new Map(); // product id → last full product parsed from the pinned page
    this._jsonDisabledUntil = 0;
  }

  /**
   * Fetch Walmart's own offer for a product id. A proxied and a direct stealth fetch race and the
   * first parsed page wins. No ScraperAPI here: it only returns the buy-box winner, and awaiting it
   * cost 15-60s of blindness after every stealth miss during the Prismatic drop.
   */
  async fetchProductPage(productId) {
    const id = String(productId);
    // selectedSellerId=0 pins Walmart's own offer — the plain page only shows the buy-box winner,
    // which lagged ~70s behind Walmart's offer going live during the Prismatic drop
    const url = `https://www.walmart.ca/ip/${id}?selectedSellerId=0`;
    const start = Date.now();

    // The ~7KB JSON legs run every cycle; the ~330KB page legs (which can see Walmart's offer before
    // it wins the buy box) every third cycle, or until a first page parse exists to seed the JSON leg
    this._cycle = (this._cycle || 0) + 1;
    const attempts = [
      this._fetchOfferJson(id, getProxyUrl('residential')).then(r => ({ ...r, via: 'json' })),
      this._fetchOfferJson(id, null).then(r => ({ ...r, via: 'json-direct' })),
    ];
    if (!this._lastPageProduct.has(id) || this._cycle % 3 === 0) {
      attempts.push(
        this._stealthFetchProduct(url, id, getProxyUrl('residential')).then(r => this._notePageResult(id, { ...r, via: 'proxy' })),
        this._stealthFetchProduct(url, id, null).then(r => this._notePageResult(id, { ...r, via: 'direct' })),
      );
    }
    const result = await this._raceParsed(attempts);

    if (result.product) {
      const product = result.product;
      product._watchlist = true;
      logger.info(`Walmart: WATCHLIST ${id} — "${product.name}" | inStock=${product.inStock} | $${product.price || '?'} | qty=${product._stockQty ?? '-'} limit=${product._cartLimit ?? '-'} | ${Date.now() - start}ms (${result.via})`);
      return product;
    }
    if (result.thirdParty) return null;

    // Nothing to report this cycle — say why, but only once every 30s per product
    const lastNote = this._lastMissNote?.get(id) || 0;
    if (Date.now() - lastNote > 30000) {
      (this._lastMissNote ||= new Map()).set(id, Date.now());
      const why = result.observed ? `buy box held by "${result.observed}" (JSON), page legs ${attempts.length > 2 ? 'blocked' : 'skipped'}` : 'every leg failed';
      logger.warn(`Walmart: WATCHLIST ${id} — no Walmart offer read: ${why} (${Date.now() - start}ms)`);
    }
    return null;
  }

  // After a restart (or while PerimeterX blocks page loads) the JSON leg still needs a base product:
  // fall back to the last one stored in Redis, retrying at most once a minute
  async _seedPageProduct(id) {
    const last = this._seedAttemptAt?.get(id) || 0;
    if (Date.now() - last < 60000) return null;
    (this._seedAttemptAt ||= new Map()).set(id, Date.now());
    try {
      const stored = await state.getProduct(this.id, id);
      if (!stored?.name) return null;
      this._lastPageProduct.set(id, { ...stored });
      if (stored._offerId) this._walmartOfferIds.set(id, stored._offerId);
      return stored;
    } catch {
      return null;
    }
  }

  // The JSON leg has no name/image and only sees the buy-box winner, so it needs the pinned page's
  // last product and Walmart's own offerId to build a product and recognise Walmart's offer
  _notePageResult(id, result) {
    if (result.product) {
      this._lastPageProduct.set(id, { ...result.product });
      if (result.product._offerId) this._walmartOfferIds.set(id, result.product._offerId);
    }
    return result;
  }

  /**
   * The product page's own DynamicItemById GraphQL call: ~7KB, ~1s through the proxy, and the only
   * source of the stock count (fulfillmentOptions[].availableQuantity). It reports the buy-box
   * winner, so it only stands in for Walmart's offer when the offerId matches the pinned page's.
   */
  async _fetchOfferJson(id, proxyUrl) {
    if (Date.now() < this._jsonDisabledUntil) return { product: null, thirdParty: false };
    const base = this._lastPageProduct.get(id) || await this._seedPageProduct(id);
    if (!base) return { product: null, thirdParty: false };

    const variables = JSON.stringify({ iId: id, fSId: true, enableMultiSave: false, enableVariantMigration: false });
    const url = `https://www.walmart.ca/orchestra/pdp/graphql/DynamicItemById/${DYNAMIC_ITEM_HASH}/ip/${id}?variables=${encodeURIComponent(variables)}`;
    const pageUrl = `https://www.walmart.ca/en/ip/${id}?selectedSellerId=0`;
    const correlationId = crypto.randomBytes(18).toString('base64url');

    try {
      const body = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 4000,
        rawHeaders: true,
        headers: {
          'Accept': 'application/json',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Content-Type': 'application/json',
          'Referer': pageUrl,
          'Origin': 'https://www.walmart.ca',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'x-apollo-operation-name': 'DynamicItemById',
          'x-o-gql-query': 'query DynamicItemById',
          'x-o-bu': 'WALMART-CA',
          'x-o-ccm': 'server',
          'x-o-mart': 'B2C',
          'x-o-platform': 'rweb',
          'x-o-platform-version': WALMART_PLATFORM_VERSION,
          'x-o-segment': 'oaoh',
          'x-o-item-id': id,
          'wm_mp': 'true',
          'wm_page_url': pageUrl,
          'wm_qos.correlation_id': correlationId,
          'x-o-correlation-id': correlationId,
          'traceparent': `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-00`,
        },
      });

      let json;
      try { json = JSON.parse(body); } catch { return { product: null, thirdParty: false }; }

      if (Array.isArray(json?.errors) && json.errors.some(e => /persisted/i.test(`${e.message} ${e.extensions?.code}`))) {
        this._jsonDisabledUntil = Date.now() + 10 * 60 * 1000;
        logger.warn('Walmart: DynamicItemById hash rejected — JSON leg paused 10min (walmart.ca deploy? set WALMART_DYNAMIC_ITEM_HASH)');
        return { product: null, thirdParty: false };
      }

      const item = json?.data?.product;
      if (!item) return { product: null, thirdParty: false };

      const walmartOffer = this._walmartOfferIds.get(id);
      const seller = `${item.sellerDisplayName || item.sellerName || ''}`.toLowerCase();
      const isWalmart = walmartOffer ? item.offerId === walmartOffer : (seller.includes('walmart') || item.sellerType === 'INTERNAL');
      if (!isWalmart) {
        // A marketplace seller holds the buy box — a real observation, just not Walmart's offer
        return { product: null, thirdParty: false, observed: item.sellerDisplayName || item.sellerId || '?' };
      }

      const shipping = (item.fulfillmentOptions || []).find(f => f.type === 'SHIPPING') || {};
      const inStock = (item.availabilityStatus || shipping.availabilityStatus) === 'IN_STOCK';
      const product = this.classify({
        ...base,
        price: item.priceInfo?.currentPrice?.price || base.price,
        inStock,
        canAddToCart: inStock && item.showAtc !== false,
      });
      product._offerId = item.offerId || base._offerId;
      if (item.orderLimit > 0) product._cartLimit = item.orderLimit;
      if (shipping.availableQuantity != null) product._stockQty = shipping.availableQuantity;
      return { product, thirdParty: false };
    } catch {
      return { product: null, thirdParty: false };
    }
  }

  // Resolves with the first attempt that parsed a page (a product, or a confirmed third-party page)
  _raceParsed(attempts) {
    return new Promise(resolve => {
      let pending = attempts.length;
      let settled = false;
      let observed = null;
      for (const attempt of attempts) {
        attempt.catch(() => ({ product: null, thirdParty: false })).then(r => {
          if (settled) return;
          if (r.observed) observed = r.observed;
          if (r.product || r.thirdParty) {
            settled = true;
            resolve(r);
          } else if (--pending === 0) {
            settled = true;
            resolve({ product: null, thirdParty: false, observed });
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
        timeoutMs: 5000,
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

      const group = this.searchQueries;

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
      logger.info(`Walmart: search — ${hits}/${group.length} stealth, ${Object.keys(products).length} products, ${elapsed}ms ($0)`);
      this.reportFreshness(hits, group.length);

      // Pass 2 (background): retry failed queries on a fresh IP.
      // Runs AFTER pass-1 products are returned for immediate alerting.
      // Recovered products are saved directly to Redis so they appear in the next diff.
      if (failedQueries.length > 0) {
        this._retryInBackground(failedQueries);
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
  _retryInBackground(failedQueries) {
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

        logger.info(`Walmart: search retry — ${retryHits}/${failedQueries.length} recovered, ${entries.length} products saved to Redis`);
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
