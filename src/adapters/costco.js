const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice, isTCGProduct } = require('../utils/helpers');
const { httpGet } = require('../utils/http');
const { getNextIspProxy, recordRequest, markProxySuccess, markProxyBlocked } = require('../core/proxy');
const { HttpsProxyAgent } = require('https-proxy-agent');
const scraperApi = require('../utils/scraper-api');

// Costco publishes two sitemap families. The plain `sitemap_*.xml` set has a Last-Modified of
// June 2020 and still lists WCS-era `.product.<id>.html` URLs whose IDs now 404 — scanning it
// found nothing but dead legacy products. The `sitemap_lw_*` family is the live one (regenerated
// daily, and the only family robots.txt advertises), and it carries the current TCG catalogue.
const SITEMAP_INDEX = 'sitemap_lw_index.xml';
// Which children of that index actually list products. `_p_` is the full product set; `_p_mod_`
// and `_i_mod_` are the recently-modified deltas, which is where a brand-new listing shows up
// first. Everything else in the index is warehouses, categories and static pages.
const PRODUCT_SITEMAP_RE = /sitemap_lw_(?:p|i)_(?:mod_)?\d+\.xml$/i;

// Costco's search is token-gated (the GRS API 400s without a runtime bearer, and the public
// Fusion typeahead key points at an empty collection), and its category and search pages are
// fully client-rendered — zero products in the HTML. The sitemap is the only open discovery
// channel, so it is polled on the normal cadence rather than every 6 hours.
const DISCOVERY_INTERVAL_DEFAULT = 8 * 1000;
const DISCOVERY_INTERVAL_FLOOR = 5 * 1000;
const MAX_MISSES = 3;

class CostcoAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    // Game-specific keywords (high confidence — any single match is enough)
    // Scoped to the games the client tracks: Pokemon and One Piece
    this.tcgGameKeywords = [
      'pokemon', 'pokmon', 'pokémon', 'tcg',
      'trading-card', 'trading+card', 'trading%20card',
      'one-piece', 'one+piece', 'one%20piece',
    ];
    // Product name validation — after parsing, product name must contain one of these
    // Deliberately does NOT include a bare franchise name. Costco's catalogue is broad, so
    // "Pokémon" on its own also matches Switch games, LEGO sets, pinball machines and Toniebox
    // figures. Every entry here names a card product form.
    this.tcgNameKeywords = [
      'pokemon tcg', 'pokémon tcg', 'tcg:', 'trading card', 'booster box', 'booster pack',
      'booster tin', 'booster bundle', 'elite trainer', 'etb', 'collection box',
      'premium collection', 'ex box', 'ex boxes', 'card game',
      'one piece card', 'one piece tcg',
    ];
    this.knownProductIds = new Set();
    this.lastSitemapScan = 0;

    // Conditional-GET validators per sitemap URL. Costco serves ETag + Last-Modified and
    // honours If-None-Match with a 304 in ~330ms and zero body, so discovery can run on the
    // normal poll cadence and only pay the 1.7MB download when the sitemap actually changes.
    this._sitemapValidators = new Map();
    // Product IDs that keep 404ing. Costco's 404 page is still ~1.2MB, so re-fetching dead
    // legacy IDs every 8s is pure egress. Three strikes and we stop (watchlist is exempt —
    // a watchlisted item 404s precisely until it goes live, which is the point).
    this._missCounts = new Map();

    // Watchlist: product IDs to poll before they go live (pre-drop monitoring)
    this.watchlist = new Set(config.watchlist || []);
    for (const id of this.watchlist) {
      this.knownProductIds.add(id);
    }
    this._deriveTiming();
  }

  _deriveTiming() {
    this.discoveryIntervalMs = this.timingValue(
      'discoveryIntervalMs', DISCOVERY_INTERVAL_DEFAULT, DISCOVERY_INTERVAL_FLOOR,
    );
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

    // Phase 1: discovery. Conditional GETs make this ~330ms and zero bytes when Costco has
    // not regenerated its sitemaps, so it runs on the poll cadence instead of every 6 hours.
    if (Date.now() - this.lastSitemapScan > this.discoveryIntervalMs) {
      await this.scanSitemaps();
      this.lastSitemapScan = Date.now();
    }

    // Phase 2: Check each known product page (parallel batches of 5)
    const ids = [...this.knownProductIds].filter(
      (id) => this.watchlist.has(id) || (this._missCounts.get(id) || 0) < MAX_MISSES,
    );
    const BATCH_SIZE = 5;
    let fresh = 0;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(productId => this.fetchProductPage(productId))
      );
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value) {
          products[results[j].value.sku] = results[j].value;
          fresh++;
        } else if (results[j].status === 'rejected') {
          logger.debug(`Costco: failed to fetch product ${batch[j]}: ${results[j].reason.message}`);
        }
      }
    }
    this.reportFreshness(fresh, ids.length);

    return products;
  }

  async scanSitemaps() {
    const before = this.knownProductIds.size;
    try {
      const { body: indexXml } = await this._conditionalGet(`${this.url}/${SITEMAP_INDEX}`);
      // 304 on the index does NOT prove the children are unchanged, so children are always
      // revalidated — but each of those is its own cheap 304 when nothing moved.
      if (indexXml) {
        const $ = cheerio.load(indexXml, { xmlMode: true });
        this._productSitemaps = $('sitemap > loc')
          .map((_, el) => $(el).text().trim())
          .get()
          .filter((u) => PRODUCT_SITEMAP_RE.test(u));
      }
      const targets = this._productSitemaps || [];
      if (targets.length === 0) {
        logger.warn('Costco: sitemap index listed no product sitemaps');
      }
      await Promise.all(targets.map((u) => this.scanSingleSitemap(u)));
    } catch (err) {
      logger.warn(`Costco: sitemap scan failed: ${err.message}`);
    }

    // P2-5: Cap to prevent unbounded memory growth from large sitemaps
    const MAX_KNOWN_IDS = 5000;
    if (this.knownProductIds.size > MAX_KNOWN_IDS) {
      const ids = [...this.knownProductIds];
      this.knownProductIds = new Set(ids.slice(-MAX_KNOWN_IDS));
      // Re-add watchlist items so they're never pruned
      for (const id of this.watchlist) this.knownProductIds.add(id);
      logger.warn(`Costco: capped knownProductIds to ${MAX_KNOWN_IDS} (was ${ids.length})`);
    }

    if (this.knownProductIds.size !== before) {
      logger.info(`Costco: sitemap scan — ${this.knownProductIds.size} TCG product IDs (+${this.knownProductIds.size - before})`);
    }
  }

  async scanSingleSitemap(sitemapUrl) {
    try {
      const { body: xml, notModified } = await this._conditionalGet(sitemapUrl);
      if (notModified || !xml) return;
      const $ = cheerio.load(xml, { xmlMode: true });

      $('url > loc').each((_, el) => {
        const raw = $(el).text().trim();
        // Costco percent-encodes accented slugs, so a Pokémon listing arrives as
        // "pok%C3%A9mon-tcg-..." and never matches a plain keyword compare. Decoding first is
        // what makes the current TCG catalogue visible at all.
        let url = raw.toLowerCase();
        try { url = decodeURIComponent(raw).toLowerCase(); } catch { /* keep raw on bad escapes */ }
        if (this.tcgGameKeywords.some((kw) => url.includes(kw))) {
          const newMatch = url.match(/\/(\d{5,})\/?(?:\?.*)?$/);
          const oldMatch = url.match(/\.product\.(\d{5,})\.html/);
          const id = newMatch?.[1] || oldMatch?.[1];
          if (id) this.knownProductIds.add(id);
        }
      });
    } catch (err) {
      logger.debug(`Costco: sub-sitemap scan failed for ${sitemapUrl}: ${err.message}`);
    }
  }

  /**
   * GET that sends If-None-Match / If-Modified-Since from the previous response.
   * @returns {{body: string|null, notModified: boolean}} body is null on 304.
   */
  async _conditionalGet(url) {
    const nodeFetch = require('node-fetch');
    const prev = this._sitemapValidators.get(url) || {};
    const headers = {
      'User-Agent': this._stickyUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'Accept': 'application/xml,text/xml,*/*',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'en-CA,en;q=0.9',
    };
    if (prev.etag) headers['If-None-Match'] = prev.etag;
    if (prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;

    const proxyObj = this.proxyTier === 'isp' ? getNextIspProxy(this.id) : null;
    const agent = proxyObj?.url ? new HttpsProxyAgent(proxyObj.url) : undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await nodeFetch(url, { headers, agent, signal: controller.signal });
      if (proxyObj) markProxySuccess(proxyObj);
      if (res.status === 304) return { body: null, notModified: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (etag || lastModified) this._sitemapValidators.set(url, { etag, lastModified });
      return { body: await res.text(), notModified: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchProductPage(productId) {
    const url = `${this.url}/p/-/x/${productId}`;
    let { status, html } = await this.directFetch(url);

    // 404 = not live yet (expected for watchlist), don't count as blocked
    const isBlocked = status === 403 || status === 503;
    recordRequest(this.id, isBlocked, this.proxyTier);

    if (status === 404) {
      if (this.watchlist.has(productId)) {
        logger.debug(`Costco: watchlist item ${productId} not live yet`);
      } else {
        const misses = (this._missCounts.get(productId) || 0) + 1;
        this._missCounts.set(productId, misses);
        if (misses === MAX_MISSES) {
          logger.info(`Costco: retiring ${productId} after ${MAX_MISSES} consecutive 404s`);
        }
      }
      return null;
    }
    this._missCounts.delete(productId);

    // If ISP proxy was blocked, try ScraperAPI fallback
    if (!html && isBlocked && scraperApi.isConfigured()) {
      try {
        html = await scraperApi.scraperFetch(url, {
          render: true,
          premium: true,
          country: 'ca',
          retailerId: this.id,
        });
        if (html) logger.debug(`Costco: ScraperAPI fallback succeeded for ${productId}`);
      } catch (err) {
        logger.debug(`Costco: ScraperAPI fallback failed for ${productId}: ${err.message}`);
      }
    }

    if (!html) return null;

    // JSON-LD first (fast, reliable). RSC fallback for edge cases.
    const product = this.parseJsonLd(html, productId) || this.parseRSC(html, productId);
    if (!product && this.watchlist.has(productId)) {
      logger.warn(`Costco: WATCHLIST item ${productId} returned 200 but failed to parse — page structure may have changed`);
    }
    // Validate product name matches TCG — skip false positives from sitemap
    if (product && !this.watchlist.has(productId)) {
      const lowerName = product.name.toLowerCase();
      // The name must look like a TCG product AND survive the shared filter. "Pokémon" alone
      // is not enough — the sitemap also carries Switch games, LEGO sets and Tonies figures,
      // all of which contain the franchise name and none of which are cards.
      const isTcg = this.tcgNameKeywords.some(kw => lowerName.includes(kw))
        && isTCGProduct(product.name);
      if (!isTcg) {
        logger.debug(`Costco: skipping non-TCG product "${product.name}" (${productId})`);
        return null;
      }
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
