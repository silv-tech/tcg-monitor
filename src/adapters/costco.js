const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { httpGet } = require('../utils/http');
const { getNextIspProxy, recordRequest, markProxySuccess, markProxyBlocked } = require('../core/proxy');
const { HttpsProxyAgent } = require('https-proxy-agent');

class CostcoAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.tcgKeywords = [
      'pokemon', 'pokmon', 'pokémon', 'tcg', 'trading-card', 'trading+card',
      'trading%20card', 'one-piece', 'lorcana', 'magic-the-gathering',
      'yugioh', 'yu-gi-oh', 'dragon-ball', 'naruto', 'booster',
      'elite-trainer', 'trainer-box', 'collector', 'card-game',
    ];
    this.knownProductIds = new Set();
    this.lastSitemapScan = 0;
    this.SITEMAP_INTERVAL = 6 * 60 * 60 * 1000;

    // Watchlist: product IDs to poll before they go live (pre-drop monitoring)
    this.watchlist = new Set(config.watchlist || []);
    for (const id of this.watchlist) {
      this.knownProductIds.add(id);
    }
  }

  // Proxy-aware fetch that handles 404 gracefully (no throw on 404)
  async directFetch(url) {
    const fetch = require('node-fetch');
    const proxyObj = this.proxyTier === 'isp' ? getNextIspProxy(this.id) : null;
    const proxyUrl = proxyObj ? proxyObj.url : null;
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': this._stickyUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          'Accept-Language': 'en-CA,en;q=0.9',
        },
        agent,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (proxyObj) markProxySuccess(proxyObj);
      if (res.status === 404) return { status: 404, html: null };
      if (res.status === 403 || res.status === 503) {
        if (proxyObj) markProxyBlocked(proxyObj);
        return { status: res.status, html: null };
      }
      if (!res.ok) return { status: res.status, html: null };
      const html = await res.text();
      return { status: 200, html };
    } catch (err) {
      clearTimeout(timer);
      if (proxyObj && (err.message?.includes('ECONNREFUSED') || err.message?.includes('socket hang up'))) {
        markProxyBlocked(proxyObj);
      }
      throw err;
    }
  }

  async fetchProducts() {
    const products = {};

    // Phase 1: Discover product URLs from sitemaps (every 6 hours)
    if (Date.now() - this.lastSitemapScan > this.SITEMAP_INTERVAL) {
      await this.scanSitemaps();
      this.lastSitemapScan = Date.now();
    }

    // Phase 2: Check each known product page
    for (const productId of this.knownProductIds) {
      try {
        const product = await this.fetchProductPage(productId);
        if (product) {
          products[product.sku] = product;
        }
      } catch (err) {
        logger.debug(`Costco: failed to fetch product ${productId}: ${err.message}`);
      }
    }

    return products;
  }

  async scanSitemaps() {
    const sitemapIndexes = [
      `${this.url}/sitemap_index.xml`,
      `${this.url}/sitemap_lw_index.xml`,
    ];

    for (const indexUrl of sitemapIndexes) {
      try {
        const xml = await this.fetch(indexUrl, { timeoutMs: 30000 });
        const $ = cheerio.load(xml, { xmlMode: true });
        const subSitemaps = [];

        $('sitemap > loc').each((_, el) => {
          subSitemaps.push($(el).text().trim());
        });

        for (const smUrl of subSitemaps) {
          await this.scanSingleSitemap(smUrl);
        }
      } catch (err) {
        logger.warn(`Costco: sitemap index scan failed for ${indexUrl}: ${err.message}`);
      }
    }

    logger.info(`Costco: sitemap scan found ${this.knownProductIds.size} TCG product IDs`);
  }

  async scanSingleSitemap(sitemapUrl) {
    try {
      const xml = await this.fetch(sitemapUrl, { timeoutMs: 30000 });
      const $ = cheerio.load(xml, { xmlMode: true });

      $('url > loc').each((_, el) => {
        const url = $(el).text().trim().toLowerCase();
        if (this.tcgKeywords.some((kw) => url.includes(kw))) {
          const newMatch = url.match(/\/(\d{5,})\s*$/);
          const oldMatch = url.match(/\.product\.(\d{5,})\.html/);
          const id = newMatch?.[1] || oldMatch?.[1];
          if (id) this.knownProductIds.add(id);
        }
      });
    } catch (err) {
      logger.debug(`Costco: sub-sitemap scan failed for ${sitemapUrl}: ${err.message}`);
    }
  }

  async fetchProductPage(productId) {
    const url = `${this.url}/p/-/x/${productId}`;
    const { status, html } = await this.directFetch(url);

    // 404 = not live yet (expected for watchlist), don't count as blocked
    const isBlocked = status === 403 || status === 503;
    recordRequest(this.id, isBlocked, this.proxyTier);

    if (status === 404) {
      if (this.watchlist.has(productId)) {
        logger.debug(`Costco: watchlist item ${productId} not live yet`);
      }
      return null;
    }

    if (!html) return null;

    // JSON-LD first (fast, reliable). RSC fallback for edge cases.
    const product = this.parseJsonLd(html, productId) || this.parseRSC(html, productId);
    if (!product && this.watchlist.has(productId)) {
      logger.warn(`Costco: WATCHLIST item ${productId} returned 200 but failed to parse — page structure may have changed`);
    }
    return product;
  }

  // Parse JSON-LD — uses indexOf (pages are 2MB+, regex backtracks catastrophically)
  parseJsonLd(html, productId) {
    let productData = null;
    let idx = 0;

    while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
      const start = html.indexOf('>', idx) + 1;
      const end = html.indexOf('</script>', start);
      if (end === -1) break;

      try {
        const json = JSON.parse(html.substring(start, end).trim());
        if (json['@type'] === 'Product') {
          productData = json;
          break;
        }
      } catch (e) {
        // skip
      }
      idx = end;
    }

    if (!productData) return null;

    const availability = productData.offers?.availability || '';
    const inStock = availability.includes('InStock');

    const product = this.classify({
      sku: productData.sku || productId,
      name: productData.name,
      price:
        typeof productData.offers?.price === 'number'
          ? productData.offers.price
          : normalizePrice(String(productData.offers?.price)),
      currency: productData.offers?.priceCurrency || 'CAD',
      url: productData.url || `${this.url}/p/-/x/${productId}`,
      image: productData.image || '',
      inStock,
      canAddToCart: inStock,
      shipsToHome: true,
    });
    if (this.watchlist.has(productId)) product._watchlist = true;
    return product;
  }

  // Parse RSC data — fallback if JSON-LD absent
  parseRSC(html, productId) {
    if (!html.includes('productDetailsData')) return null;

    const start = html.indexOf('"productDetailsData"');
    if (start === -1) return null;

    const chunk = html.substring(start, start + 10000);

    if (chunk.includes('"isPublished":false') || chunk.includes('"isBuyable":false')) {
      logger.debug(`Costco: product ${productId} not published/buyable`);
      return null;
    }

    if (!chunk.includes('"isPublished":true')) return null;

    const priceMatch = chunk.match(/"(?:finalPrice|price)":\s*([\d.]+)/);
    const nameMatch = chunk.match(/"(?:name|productName)":\s*"([^"]+)"/);
    const imageMatch = chunk.match(/"(?:imageUrl|url)":\s*"(https:\/\/[^"]+)"/);

    if (!nameMatch) return null;

    const product = this.classify({
      sku: productId,
      name: nameMatch[1],
      price: priceMatch ? parseFloat(priceMatch[1]) : 0,
      currency: 'CAD',
      url: `${this.url}/p/-/x/${productId}`,
      image: imageMatch ? imageMatch[1] : '',
      inStock: true,
      canAddToCart: true,
      shipsToHome: chunk.includes('ShipIt'),
    });
    if (this.watchlist.has(productId)) product._watchlist = true;
    return product;
  }

  addProductId(id) {
    this.knownProductIds.add(id);
  }

  removeProductId(id) {
    this.knownProductIds.delete(id);
  }
}

module.exports = CostcoAdapter;
