const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, isTCGProduct, sleep } = require('../utils/helpers');
const { amazonSearch, isConfigured } = require('../utils/scraper-api');
const { getProxyUrl } = require('../core/proxy');
const { stealthGet, _clearCache } = require('../utils/stealth-http');

// Game names that we track — Amazon results MUST match one of these
const GAME_NAMES = [
  'pokemon', 'pokémon', 'one piece', 'dragon ball', 'lorcana',
  'yugioh', 'yu-gi-oh', 'magic the gathering', 'digimon',
  'naruto', 'star wars unlimited', 'flesh and blood', 'union arena',
  'weiss schwarz', 'cardfight vanguard',
];

// Accessories — never alert on these even if they mention a game name
const ACCESSORY_KEYWORDS = [
  'deck box', 'deckbox', 'playmat', 'play mat', 'sleeves', 'card sleeves',
  'penny sleeves', 'card protector', 'protector case', 'toploader', 'top loader',
  'display case', 'acrylic', 'portfolio', 'binder', 'card binder', 'album',
  'card holder', 'card organizer', 'storage box', 'card storage',
  'pet plastic', 'dice set', 'dice bag', 'coin holder', 'token box', 'token deck',
  'divider', 'accessories',
];

// How often to run the paid ScraperAPI search for NEW listings. This is the whole
// ScraperAPI bill: 3 queries x 5 credits per run. It does NOT affect restock speed —
// _monitorKnownAsins re-checks every known ASIN on every poll, free, regardless.
const DISCOVERY_INTERVAL_DEFAULT = 30 * 60 * 1000;
const DISCOVERY_INTERVAL_FLOOR = 5 * 60 * 1000;

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    this._knownProducts = new Map(); // ASIN → classified product (persists between polls)
    this._lastDiscoveryAt = 0;       // timestamp of last ScraperAPI discovery
    this._monitorSuccessRate = 0;    // track product page stealth success %
    this._deriveTiming();

    // Consolidated queries — removed 5 redundant Pokemon queries
    // "pokemon tcg sealed" covers ETBs, UPCs, bundles, preorders, collections
    this.searchQueries = [
      'pokemon tcg booster box',
      'pokemon tcg sealed',
      'one piece card game booster box',
    ];
  }

  _deriveTiming() {
    this.discoveryIntervalMs = this.timingValue('discoveryIntervalMs', DISCOVERY_INTERVAL_DEFAULT, DISCOVERY_INTERVAL_FLOOR);
  }

  /**
   * Stealth-fetch a single Amazon product page and parse for price/stock.
   * Product pages have lighter bot detection than search pages.
   */
  async _stealthCheckAsin(asin) {
    const url = `https://www.amazon.ca/dp/${asin}`;
    const proxyUrl = getProxyUrl('residential');

    try {
      // Plain navigation headers only: with stealthGet's default `Cache-Control: no-cache` (a hard-reload
      // signal) Amazon answers with a 3.7KB "continue shopping" interstitial instead of the product page
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 12000,
        rawHeaders: true,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
      });

      if (!html || html.length < 2000) return null;
      if (html.includes('Click the button below to continue shopping')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      // Bot detection / CAPTCHA pages
      if (html.includes('Robot Check') || html.includes('captcha') ||
          html.includes('Type the characters') || html.includes('Sorry, we just need to make sure')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      return this._parseProductPage(html, asin);
    } catch {
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  /**
   * Parse Amazon product page HTML for title, price, stock status, image.
   */
  _parseProductPage(html, asin) {
    // Title: <span id="productTitle">...</span>
    let name = null;
    const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)/);
    if (titleMatch) name = titleMatch[1].trim();
    if (!name || name.length < 10) return null;

    // Price — try multiple locations (Amazon uses different layouts)
    let price = null;
    // 1. a-offscreen (most reliable — screen reader price, always present)
    const offscreenMatch = html.match(/class="a-offscreen">\s*\$?([\d,]+\.\d{2})\s*</);
    if (offscreenMatch) price = normalizePrice(offscreenMatch[1]);
    // 2. a-price-whole + a-price-fraction
    if (!price) {
      const wholeMatch = html.match(/class="a-price-whole">\s*(\d[\d,]*)/);
      const fracMatch = html.match(/class="a-price-fraction">(\d+)/);
      if (wholeMatch) {
        const whole = wholeMatch[1].replace(/,/g, '');
        price = parseFloat(`${whole}.${fracMatch ? fracMatch[1] : '00'}`);
      }
    }
    // 3. priceblock_ourprice (older layout)
    if (!price) {
      const blockMatch = html.match(/id="priceblock_ourprice"[^>]*>\s*\$?([\d,]+\.\d{2})/);
      if (blockMatch) price = normalizePrice(blockMatch[1]);
    }

    // Stock status — check for add-to-cart button and OOS indicators
    const hasAddToCart = html.includes('id="add-to-cart-button"') ||
                         html.includes('id="submit.add-to-cart"') ||
                         html.includes('name="submit.add-to-cart"');
    const isOOS = html.includes('Currently unavailable') ||
                  html.includes('id="outOfStockBuyBox"') ||
                  html.includes('not available for purchase');
    const inStock = hasAddToCart && !isOOS;

    // Image: <img id="landingImage" src="...">
    let image = '';
    const imgMatch = html.match(/id="landingImage"[^>]*src="([^"]+)"/);
    if (imgMatch) image = imgMatch[1];
    if (!image) {
      const hiresMatch = html.match(/data-old-hires="([^"]+)"/);
      if (hiresMatch) image = hiresMatch[1];
    }

    return { asin, name, price, inStock, image };
  }

  async fetchProducts() {
    const products = {};
    const now = Date.now();
    const timeSinceDiscovery = now - this._lastDiscoveryAt;
    const needsDiscovery = timeSinceDiscovery >= this.discoveryIntervalMs || this._knownProducts.size === 0;

    if (needsDiscovery) {
      // ── DISCOVERY ── ScraperAPI search for new products (paid, every 10 min)
      await this._runDiscovery(products);
      this._lastDiscoveryAt = now;

      // Update known products cache
      for (const [sku, product] of Object.entries(products)) {
        this._knownProducts.set(sku, product);
      }

      // Prune products not seen in 24h
      for (const [asin, data] of this._knownProducts) {
        if (!(asin in products) && (now - (data.lastSeen || 0)) > 24 * 60 * 60 * 1000) {
          this._knownProducts.delete(asin);
        }
      }

      logger.info(`Amazon: DISCOVERY — ${Object.keys(products).length} products, ${this._knownProducts.size} known ASINs. Next in ${Math.round(this.discoveryIntervalMs / 60000)}min.`);
    } else {
      // ── MONITOR ── Stealth-check known ASINs via /dp/ pages (FREE, every poll)
      await this._monitorKnownAsins(products);
    }

    return products;
  }

  /**
   * Discovery: ScraperAPI search queries to find NEW products.
   * 14 queries × 5 credits = 70 credits per discovery (every 10 min).
   */
  async _runDiscovery(products) {
    if (!isConfigured()) {
      logger.warn('Amazon: ScraperAPI not configured, returning cached products');
      for (const [asin, data] of this._knownProducts) {
        products[asin] = data;
      }
      return;
    }

    const scraperResults = await Promise.allSettled(
      this.searchQueries.map(query =>
        amazonSearch(query, { retailerId: this.id })
          .then(data => ({ query, data }))
      )
    );

    let queryCount = 0;
    for (const result of scraperResults) {
      if (result.status === 'rejected') {
        logger.warn(`Amazon: discovery failed: ${result.reason.message}`);
        continue;
      }
      const { query, data } = result.value;
      if (!data) continue; // rate-limited

      const results = data.results || data.organic_results || data.search_results ||
        data.items || data.ads || [];
      if (results.length === 0) continue;

      queryCount++;
      this._processSearchItems(results, products);
      logger.info(`Amazon: "${query}" — ${results.length} results (discovery, 5 credits)`);
    }

    // Also include previously known ASINs not in this discovery (may still be live)
    for (const [asin, cached] of this._knownProducts) {
      if (!(asin in products)) {
        products[asin] = cached;
      }
    }

    logger.info(`Amazon: discovery — ${queryCount} queries returned data (${queryCount * 5} credits).`);
  }

  /**
   * Monitor: stealth-check known ASINs via product pages (FREE).
   * Returns cached data for ASINs where stealth fails (prevents false OOS).
   */
  async _monitorKnownAsins(products) {
    const asins = [...this._knownProducts.keys()];
    if (asins.length === 0) {
      logger.debug('Amazon: no known ASINs — waiting for discovery');
      return;
    }

    let checked = 0;
    let updated = 0;
    const BATCH = 4;

    for (let i = 0; i < asins.length; i += BATCH) {
      const batch = asins.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(asin => this._stealthCheckAsin(asin).then(data => ({ asin, data })))
      );

      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { asin, data } = result.value;
        checked++;

        if (data) {
          updated++;
          const cached = this._knownProducts.get(asin);
          // Keep cached identity (name, category, retailer) — update price + stock only
          const product = {
            ...cached,
            price: data.price || cached.price,
            inStock: data.inStock,
            canAddToCart: data.inStock,
            image: data.image || cached.image,
            lastSeen: Date.now(),
          };
          this._knownProducts.set(asin, product);
          products[asin] = product;
        } else {
          // Stealth failed — return cached data unchanged (no false OOS events)
          const cached = this._knownProducts.get(asin);
          if (cached) products[asin] = cached;
        }
      }

      // IP rotation between batches
      if (i + BATCH < asins.length) {
        const px = getProxyUrl('residential');
        if (px) _clearCache(px);
        await sleep(1000 + Math.floor(Math.random() * 1500));
      }
    }

    this._monitorSuccessRate = asins.length > 0 ? Math.round((updated / asins.length) * 100) : 0;
    logger.info(`Amazon: MONITOR — ${updated}/${checked} ASINs updated (free stealth). ${this._monitorSuccessRate}% success.`);
  }

  /**
   * Fetch a single product page — used by watchlist fast-polling.
   */
  async fetchProductPage(asin) {
    const data = await this._stealthCheckAsin(asin);
    if (!data) return null;

    // Apply game name + TCG filters
    const lowerName = data.name.toLowerCase();
    const hasGameName = GAME_NAMES.some(g => lowerName.includes(g));
    if (!hasGameName) return null;
    if (!isTCGProduct(data.name)) return null;

    return this.classify({
      sku: asin,
      name: data.name,
      price: data.price,
      currency: 'CAD',
      url: `https://www.amazon.ca/dp/${asin}`,
      image: data.image || '',
      inStock: data.inStock,
      canAddToCart: data.inStock,
      shipsToHome: true,
    });
  }

  /**
   * Process search result items into classified products.
   * Used by discovery (ScraperAPI JSON results).
   * Applies all 5 filter layers: game name, TCG product, accessory, seller, price.
   */
  _processSearchItems(items, products) {
    for (const item of items) {
      try {
        const asin = item.asin || item.ASIN;
        if (!asin) continue;

        const name = item.name || item.title;
        if (!name) continue;

        const lowerName = name.toLowerCase();

        // Layer 1: Must mention a game we actually track
        const hasGameName = GAME_NAMES.some(g => lowerName.includes(g));
        if (!hasGameName) continue;

        // Layer 2: Must pass shared TCG product filter (sealed products, not figures/toys)
        if (!isTCGProduct(name)) continue;

        // Layer 3: Exclude accessories (deck boxes, binders, sleeves, etc.)
        const isAccessory = ACCESSORY_KEYWORDS.some(kw => lowerName.includes(kw));
        if (isAccessory) continue;

        // Layer 4: emi= URL filter restricts to "sold by Amazon.ca" at search level.
        // Double-check if seller data is present.
        const seller = (item.sold_by || item.seller || '').toLowerCase();
        if (seller && !seller.includes('amazon')) continue;

        const price = typeof item.price === 'number' ? item.price :
          normalizePrice(item.price_string || item.price || item.current_price);

        // Layer 5: Must have a real price
        if (price == null || price <= 0) continue;

        const url = item.url || item.product_url || item.link ||
          `https://www.amazon.ca/dp/${asin}`;
        const fullUrl = url.startsWith('http') ? url : `https://www.amazon.ca${url}`;

        const image = item.image || item.thumbnail || '';
        const inStock = true;

        const product = this.classify({
          sku: asin,
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
        logger.debug(`Amazon: failed to parse item: ${err.message}`);
      }
    }
  }
}

module.exports = AmazonAdapter;
