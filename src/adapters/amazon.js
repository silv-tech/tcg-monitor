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

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    // Search queries — autoparse with emi= filter ensures "sold by Amazon" only
    this.searchQueries = [
      // Pokemon (highest demand — multiple queries for coverage)
      'pokemon tcg booster box',
      'pokemon elite trainer box',
      'pokemon tcg collection box',
      'pokemon tcg sealed',
      'pokemon tcg preorder',
      'pokemon tcg booster bundle',
      'pokemon tcg ultra premium collection',
      // Other TCGs
      'one piece card game booster box',
      'dragon ball super card game booster box',
      'yu-gi-oh booster box',
      'lorcana booster box',
      'magic the gathering booster box',
      'digimon card game booster box',
      'flesh and blood tcg booster box',
      'weiss schwarz booster box',
      'cardfight vanguard booster box',
      'union arena booster box',
      'star wars unlimited booster box',
      'naruto boruto card game',
    ];
  }

  /**
   * Stealth-fetch an Amazon.ca search page and parse HTML for product results.
   * emi=A3DWYIK6Y9EEQB restricts to Amazon-sold items at the URL level.
   */
  async _stealthSearch(query) {
    // emi= is Amazon.ca's seller ID — restricts results to "sold by Amazon"
    const url = `https://www.amazon.ca/s?k=${encodeURIComponent(query)}&emi=A3DWYIK6Y9EEQB`;
    const proxyUrl = getProxyUrl('residential');

    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 15000,
      });

      if (!html || html.length < 1000) return null;

      // Amazon CAPTCHA / bot check pages
      if (html.includes('Robot Check') || html.includes('captcha') ||
          html.includes('Type the characters') || html.includes('Sorry, we just need to make sure')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      return this._parseSearchHtml(html);
    } catch {
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  /**
   * Parse Amazon search page HTML for product data.
   * Extracts from data-asin divs: ASIN, title, price, image, URL.
   */
  _parseSearchHtml(html) {
    const items = [];

    // Match each search result div with data-asin attribute
    // Amazon uses: <div data-asin="B0XXXXXX" ... data-component-type="s-search-result">
    const asinRegex = /data-asin="(B[A-Z0-9]{9})"/g;
    const asins = new Set();
    let match;
    while ((match = asinRegex.exec(html)) !== null) {
      asins.add(match[1]);
    }

    if (asins.size === 0) return null;

    for (const asin of asins) {
      // Find the block for this ASIN — search for the next ~5000 chars after the data-asin
      const asinIdx = html.indexOf(`data-asin="${asin}"`);
      if (asinIdx === -1) continue;
      const block = html.substring(asinIdx, asinIdx + 5000);

      // Extract title from <span class="a-text-normal"> or <h2> <a> <span>
      let name = null;
      const titleMatch = block.match(/class="a-size-(?:base-plus|medium)[^"]*a-text-normal[^"]*"[^>]*>([^<]+)</);
      if (titleMatch) {
        name = titleMatch[1].trim();
      } else {
        // Fallback: look for any <span class="a-text-normal">
        const fallback = block.match(/class="a-text-normal"[^>]*>([^<]+)</);
        if (fallback) name = fallback[1].trim();
      }
      if (!name || name.length < 10) continue;

      // Extract price from <span class="a-offscreen">$XX.XX</span>
      let price = null;
      const priceMatch = block.match(/class="a-offscreen">\s*\$?([\d,]+\.?\d*)\s*<\/span>/);
      if (priceMatch) {
        price = normalizePrice(priceMatch[1]);
      }

      // Extract image from <img class="s-image" src="..."
      let image = '';
      const imgMatch = block.match(/class="s-image"[^>]*src="([^"]+)"/);
      if (imgMatch) image = imgMatch[1];

      // URL is always /dp/ASIN
      const url = `https://www.amazon.ca/dp/${asin}`;

      items.push({
        asin,
        name,
        price,
        url,
        image,
        sold_by: '', // emi= filter ensures Amazon-sold at URL level
      });
    }

    return items.length > 0 ? items : null;
  }

  async fetchProducts() {
    const products = {};
    const proxyUrl = getProxyUrl('residential');
    const failedQueries = [];
    let stealthHits = 0;

    // Step 1: Stealth search (free) — batches of 4 with jitter
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
        logger.info(`Amazon: "${query}" — ${items.length} results (stealth, free)`);
      }

      // Rotate IP + delay between batches
      if (i + BATCH_SIZE < this.searchQueries.length) {
        const px = getProxyUrl('residential');
        if (px) _clearCache(px);
        await sleep(1500 + Math.floor(Math.random() * 1500));
      }
    }

    // Step 1.5: Retry failed queries with fresh IPs before burning ScraperAPI credits
    if (failedQueries.length > 0) {
      const retryQueries = [...failedQueries];
      failedQueries.length = 0;

      const retryProxy = getProxyUrl('residential');
      if (retryProxy) _clearCache(retryProxy);
      await sleep(2000 + Math.floor(Math.random() * 2000));

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
          logger.info(`Amazon: "${query}" — ${items.length} results (stealth retry, free)`);
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
          amazonSearch(query, { retailerId: this.id })
            .then(data => ({ query, data }))
        )
      );

      for (const result of scraperResults) {
        if (result.status === 'rejected') {
          logger.warn(`Amazon: search failed: ${result.reason.message}`);
          continue;
        }
        const { query, data } = result.value;
        if (!data) continue;

        const results = data.results || data.organic_results || data.search_results ||
          data.items || data.ads || [];
        if (results.length === 0) continue;

        this._processSearchItems(results, products);
        logger.info(`Amazon: "${query}" — ${results.length} results (scraper fallback, 5 credits)`);
      }
    }

    logger.info(`Amazon: ${stealthHits}/${this.searchQueries.length} queries free (stealth), ${failedQueries.length} used ScraperAPI. ${Object.keys(products).length} total products.`);

    return products;
  }

  /**
   * Process search result items into classified products.
   * Shared by both stealth and ScraperAPI search paths.
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
