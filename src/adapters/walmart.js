const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
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
      // Pokemon (highest demand — multiple queries for coverage)
      'pokemon tcg',
      'pokemon booster box',
      'pokemon elite trainer box',
      'pokemon tcg collection',
      // Other TCGs
      'one piece card game',
      'dragon ball super card game',
      'yu-gi-oh booster box',
      'lorcana booster box',
      'magic the gathering booster box',
      'digimon card game',
      'flesh and blood tcg',
      'weiss schwarz booster',
      'cardfight vanguard',
      'union arena card game',
      'star wars unlimited',
      'naruto boruto card game',
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
      logger.info(`Walmart: WATCHLIST ${productId} — "${name}" | inStock=${inStock} | $${price || '?'} (scraper fallback)`);
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
    // Method 1: JSON-LD (most reliable)
    let idx = 0;
    while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
      const start = html.indexOf('>', idx) + 1;
      const end = html.indexOf('</script>', start);
      if (end === -1) break;

      try {
        const json = JSON.parse(html.substring(start, end).trim());
        // Could be a single Product or an array
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

    // Method 2: __NEXT_DATA__ (Walmart uses Next.js)
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
      const sellerName = (item.seller || item.sellerName || item.soldBy || '').toLowerCase();
      if (sellerName && !sellerName.includes('walmart')) {
        logger.info(`Walmart: WATCHLIST ${productId} — skipping third-party seller: "${item.seller || item.sellerName || item.soldBy}" (nextData)`);
        return null;
      }

      const price = item.price?.currentPrice || item.priceInfo?.currentPrice?.price;
      const avail = (item.availabilityStatus || item.availability || '').toLowerCase();
      const inStock = avail.includes('in_stock') || avail.includes('available');

      return this.classify({
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
    } catch {
      return null;
    }
  }

  async fetchProducts() {
    if (!isConfigured()) {
      throw new Error('Walmart: SCRAPER_API_KEY not configured — structured endpoint required');
    }

    const products = {};

    // Parallel search queries (#6)
    const searchResults = await Promise.allSettled(
      this.searchQueries.map(query =>
        walmartSearch(query, { tld: 'ca', retailerId: this.id })
          .then(data => ({ query, data }))
      )
    );

    for (const result of searchResults) {
      if (result.status === 'rejected') {
        logger.warn(`Walmart: structured search failed: ${result.reason.message}`);
        continue;
      }
      const { query, data } = result.value;
      if (!data) {
        logger.debug(`Walmart: rate-limited for "${query}"`);
        continue;
      }

      const results = data.items || data.results || data.search_results || [];
      if (results.length === 0) {
        logger.warn(`Walmart: 0 results from structured API for "${query}"`, { reason: 'empty_response' });
        continue;
      }

      for (const item of results) {
        try {
          if (!item.name && !item.title) continue;
          const name = item.name || item.title;

          // Skip third-party sellers (#9)
          const seller = (item.seller || item.sold_by || '').toLowerCase();
          if (seller && !seller.includes('walmart')) continue;

          const sku = item.id || item.product_id || item.us_item_id ||
            name.replace(/\s+/g, '-').toLowerCase().slice(0, 50);

          const price = typeof item.price === 'number' ? item.price :
            normalizePrice(item.price_string || item.price);

          const url = item.url || item.product_url || item.link ||
            `${this.url}/ip/${sku}`;
          const fullUrl = url.startsWith('http') ? url : `${this.url}${url}`;

          const image = item.image || item.thumbnail || '';
          const avail = (item.availability || '').toLowerCase();
          const inStock = avail ? avail.includes('in stock') || avail.includes('instock') : false;

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

      logger.info(`Walmart: "${query}" returned ${results.length} results, ${Object.keys(products).length} total products`);
    }

    return products;
  }
}

module.exports = WalmartAdapter;
