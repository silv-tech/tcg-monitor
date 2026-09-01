const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { FAILURE_REASONS, classifyError } = require('../core/failure-reasons');

let patchright;
try { patchright = require('patchright'); } catch { patchright = null; }

class PokemonCenterAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.sitemapUrl = 'https://www.pokemoncenter.com/sitemaps/products.xml';
    this.domain = 'www.pokemoncenter.com';
    this.seedUrl = 'https://www.pokemoncenter.com/en-ca/';
    this.API_BASE = 'https://www.pokemoncenter.com/tpci-ecommweb-api';

    // TCG sealed product keywords for filtering sitemap URLs
    this.tcgKeywords = [
      'pokemon-tcg-', '-tcg-',
      'booster-box', 'booster-bundle', 'elite-trainer-box',
      'collection-box', 'special-collection', 'premium-collection',
      'build-and-battle', 'league-battle-deck', 'ultra-premium',
      'poster-collection', 'tech-sticker-collection',
      'combined-powers', 'super-premium',
      'scarlet-violet', 'prismatic-evolutions',
      'surging-sparks', 'stellar-crown', 'twilight-masquerade',
      'shrouded-fable', 'paldean-fates', 'paradox-rift',
      'temporal-forces', 'obsidian-flames', 'paldea-evolved',
      'astral-radiance', 'brilliant-stars', 'lost-origin',
      'silver-tempest', 'crown-zenith',
    ];

    // Product cache from sitemap — persists across polls
    this.sitemapProducts = new Map(); // sku -> { url, name }
    this.availabilityCache = new Map(); // sku -> { inStock, price, image }
    this.lastSitemapScan = 0;
    this.SITEMAP_INTERVAL = 30 * 60 * 1000; // 30 minutes

    // Availability check rotation — API calls are fast, can check more per poll
    this.checkIndex = 0;
    this.CHECKS_PER_POLL = 50;

    // Bearer token for direct Elastic Path API calls
    this._bearerToken = null;
    this._tokenExpiresAt = 0;
    this._tokenRefreshing = false;
  }

  isChallengePage(html) {
    return html.includes('Pardon Our Interruption') ||
      html.includes('distil_referrer') ||
      html.includes('Incapsula') ||
      (html.length < 5000 && !html.includes('<loc>') && !html.includes('<html'));
  }

  /**
   * Capture a Bearer token by solving Incapsula with Patchright
   * and intercepting API requests made by the frontend.
   */
  async captureToken() {
    if (!patchright) {
      logger.warn('Pokemon Center: patchright not available for token capture');
      return null;
    }

    const { url: proxyUrl } = this.getProxy();
    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    };

    if (proxyUrl) {
      try {
        const url = new URL(proxyUrl);
        launchOpts.proxy = {
          server: `${url.protocol}//${url.hostname}:${url.port}`,
          username: url.username || undefined,
          password: url.password || undefined,
        };
      } catch {}
    }

    let browser;
    try {
      browser = await patchright.chromium.launch(launchOpts);
      const context = await browser.newContext({
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
        viewport: { width: 1920, height: 1080 },
      });
      const page = await context.newPage();

      let token = null;

      // Intercept requests to capture Bearer token from API calls
      page.on('request', req => {
        const auth = req.headers()['authorization'];
        if (auth?.startsWith('Bearer ') && req.url().includes('tpci-ecommweb-api')) {
          token = auth.slice(7);
        }
      });

      // Block heavy resources
      await page.route('**/*', route => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) return route.abort();
        return route.continue();
      });

      // Visit homepage to solve Incapsula challenge
      await page.goto(this.seedUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(10000);

      // If no token yet, visit a product page to trigger tpci-ecommweb-api calls
      if (!token && this.sitemapProducts.size > 0) {
        const firstUrl = [...this.sitemapProducts.values()][0]?.url;
        if (firstUrl) {
          logger.debug(`Pokemon Center: navigating to product page for token capture...`);
          await page.goto(firstUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(5000);
        }
      }

      // Also try to extract token from page JS context
      if (!token) {
        try {
          token = await page.evaluate(() => {
            // Check for token in common storage locations
            const stored = sessionStorage.getItem('ep_token') ||
              sessionStorage.getItem('bearer_token') ||
              localStorage.getItem('ep_token') ||
              localStorage.getItem('bearer_token');
            if (stored) return stored;

            // Check cookies
            const cookies = document.cookie.split(';');
            for (const c of cookies) {
              const [name, val] = c.trim().split('=');
              if (name?.includes('token') && val?.length > 20) return val;
            }
            return null;
          });
        } catch {}
      }

      await context.close();

      if (token) {
        this._bearerToken = token;
        this._tokenExpiresAt = Date.now() + 6 * 60 * 60 * 1000; // 6 hours
        logger.info(`Pokemon Center: Bearer token captured, cached for 6h`);
        return token;
      }

      logger.warn('Pokemon Center: could not capture Bearer token from browser session');
      return null;
    } catch (err) {
      logger.warn(`Pokemon Center: token capture failed: ${err.message}`);
      return null;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  /**
   * Check product availability via direct Elastic Path API call.
   * Much faster than rendering full pages — just a POST with SKU.
   */
  async checkProductApi(sku) {
    // Ensure we have a valid token
    if (!this._bearerToken || Date.now() > this._tokenExpiresAt) {
      if (!this._tokenRefreshing) {
        this._tokenRefreshing = true;
        try {
          await this.captureToken();
        } finally {
          this._tokenRefreshing = false;
        }
      }
      if (!this._bearerToken) return null;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.API_BASE}/product?format=zoom.nodatalinks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._bearerToken}`,
          'Content-Type': 'application/json',
          'Origin': 'https://www.pokemoncenter.com',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ productSku: sku }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401) {
        logger.info('Pokemon Center: token expired, will refresh next poll');
        this._bearerToken = null;
        this._tokenExpiresAt = 0;
        return null;
      }

      if (!response.ok) {
        logger.debug(`Pokemon Center API: HTTP ${response.status} for ${sku}`);
        return null;
      }

      const data = await response.json();

      // Log first successful response for debugging
      if (!this._apiResponseLogged) {
        logger.info(`Pokemon Center API: sample response for ${sku}: ${JSON.stringify(data).substring(0, 500)}`);
        this._apiResponseLogged = true;
      }

      // Parse Elastic Path Cortex response
      const state = data?.state || data?._availability?.state || '';
      const inStock = state === 'AVAILABLE' || state === 'AVAILABLE_FOR_BACK_ORDER';
      const isPreorder = state === 'AVAILABLE_FOR_PRE_ORDER';

      // Try to find price in various response locations
      const price = data?.price?.['purchase-price']?.[0]?.amount ||
        data?.price?.['list-price']?.[0]?.amount ||
        data?.price?.amount ||
        null;

      return {
        inStock: inStock || isPreorder,
        price: price ? parseFloat(price) : null,
        image: '',
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        logger.debug(`Pokemon Center API: timeout for ${sku}`);
      } else {
        logger.debug(`Pokemon Center API: ${sku} failed: ${err.message}`);
      }
      return null;
    }
  }

  async fetchProducts() {
    const products = {};

    // Phase 1: Discover products from sitemap (every 30 min)
    if (Date.now() - this.lastSitemapScan > this.SITEMAP_INTERVAL || this.sitemapProducts.size === 0) {
      await this.scanSitemap();
      this.lastSitemapScan = Date.now();
    }

    if (this.sitemapProducts.size === 0) {
      throw new Error('No TCG products in sitemap cache');
    }

    // Phase 2: Check availability for a rotating batch of products
    const entries = [...this.sitemapProducts.entries()];
    const start = this.checkIndex % entries.length;
    const batchSize = Math.min(this.CHECKS_PER_POLL, entries.length);

    let checked = 0;
    let apiChecked = 0;
    const failureCounts = {};
    for (let i = 0; i < batchSize; i++) {
      const idx = (start + i) % entries.length;
      const [sku, meta] = entries[idx];
      try {
        const { data, failReason, method } = await this.checkProductAvailability(sku, meta);
        if (data) {
          this.availabilityCache.set(sku, data);
          checked++;
          if (method === 'api') apiChecked++;
        } else if (failReason) {
          failureCounts[failReason] = (failureCounts[failReason] || 0) + 1;
        }
      } catch (err) {
        const reason = classifyError(err);
        failureCounts[reason] = (failureCounts[reason] || 0) + 1;
        logger.debug(`Pokemon Center: check failed for ${sku}: ${err.message}`);
      }
    }
    this.checkIndex = (start + batchSize) % entries.length;

    // Phase 3: Build full product list — use cached availability for all products
    for (const [sku, meta] of this.sitemapProducts) {
      const avail = this.availabilityCache.get(sku) || { inStock: true, price: null, image: '' };
      products[sku] = this.classify({
        sku,
        name: meta.name,
        price: avail.price,
        currency: 'CAD',
        url: meta.url,
        image: avail.image || '',
        inStock: avail.inStock,
        canAddToCart: avail.inStock,
        shipsToHome: true,
      });
    }

    const failureSummary = Object.keys(failureCounts).length > 0
      ? Object.entries(failureCounts).map(([r, c]) => `${r}:${c}`).join(', ')
      : 'none';
    logger.info(`Pokemon Center: ${Object.keys(products).length} products (${checked}/${batchSize} checked, ${apiChecked} via API) — failures: ${failureSummary}`);
    return products;
  }

  async scanSitemap() {
    let xml;

    // Try browser first (free), fall back to ScraperAPI (paid) on challenge
    try {
      xml = await this.protectedFetch(this.sitemapUrl, {
        timeoutMs: 45000,
        challengeDetector: (h) => !h.includes('<loc>') || this.isChallengePage(h),
        scraperOpts: { render: false, ultraPremium: true },
      });
    } catch (err) {
      if (this.sitemapProducts.size > 0) {
        logger.warn(`Pokemon Center: sitemap fetch failed, using ${this.sitemapProducts.size} cached products`);
        return;
      }
      throw new Error(`Sitemap unreachable: ${err.message}`);
    }

    if (!xml || !xml.includes('<loc>') || this.isChallengePage(xml)) {
      if (this.sitemapProducts.size > 0) {
        logger.warn('Pokemon Center: sitemap returned challenge/empty, using cached products');
        return;
      }
      throw new Error('Sitemap returned challenge page — all methods failed');
    }

    // Parse product URLs from sitemap
    const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
    const newProducts = new Map();

    for (const match of urlMatches) {
      const url = match.replace(/<\/?loc>/g, '');
      if (!url.includes('/product/')) continue;

      const parts = url.split('/');
      const slug = parts[parts.length - 1] || '';
      const sku = parts[parts.length - 2] || '';
      if (!sku || !slug) continue;

      const lowerSlug = slug.toLowerCase();
      if (!this.tcgKeywords.some(kw => lowerSlug.includes(kw))) continue;

      const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const caUrl = url.replace(/\/en-[a-z]{2}\/product\//, '/en-ca/product/')
        .replace(/^(https?:\/\/[^/]+)\/product\//, '$1/en-ca/product/');

      newProducts.set(sku, { url: caUrl, name });
    }

    if (newProducts.size > 0) {
      this.sitemapProducts = newProducts;
    }

    logger.info(`Pokemon Center: sitemap found ${newProducts.size} TCG products (${urlMatches.length} total URLs)`);
  }

  async checkProductAvailability(sku, meta) {
    // Try direct API first (fast, no browser needed)
    const apiResult = await this.checkProductApi(sku);
    if (apiResult) return { data: apiResult, failReason: null, method: 'api' };

    // Fall back to page scraping via protectedFetch
    let html;
    try {
      html = await this.protectedFetch(meta.url, {
        timeoutMs: 20000,
        challengeDetector: (h) => this.isChallengePage(h),
        scraperOpts: { ultraPremium: true },
      });
    } catch (err) {
      const reason = classifyError(err);
      logger.warn(`Pokemon Center: fetch failed for ${sku}`, { reason, url: meta.url, error: err.message });
      return { data: null, failReason: reason, method: 'scrape' };
    }

    if (!html) {
      logger.debug(`Pokemon Center: empty response for ${sku}`);
      return { data: null, failReason: FAILURE_REASONS.EMPTY_RESPONSE, method: 'scrape' };
    }
    if (this.isChallengePage(html)) {
      logger.debug(`Pokemon Center: all methods returned challenge for ${sku}`);
      return { data: null, failReason: FAILURE_REASONS.BOT_CHALLENGE, method: 'scrape' };
    }

    // Try JSON-LD first (most reliable)
    const jsonLd = this.parseJsonLd(html);
    if (jsonLd) return { data: jsonLd, failReason: null, method: 'scrape' };

    // Try __NEXT_DATA__ embedded JSON
    const nextData = this.parseNextData(html);
    if (nextData) return { data: nextData, failReason: null, method: 'scrape' };

    // Fallback: HTML text markers
    const markers = this.parseHtmlMarkers(html);
    if (markers) return { data: markers, failReason: null, method: 'scrape' };

    logger.debug(`Pokemon Center: no parseable data for ${sku}`);
    return { data: null, failReason: FAILURE_REASONS.NO_MARKERS, method: 'scrape' };
  }

  parseJsonLd(html) {
    let idx = 0;
    while ((idx = html.indexOf('application/ld+json', idx)) !== -1) {
      const start = html.indexOf('>', idx) + 1;
      const end = html.indexOf('</script>', start);
      if (end === -1) break;
      try {
        const json = JSON.parse(html.substring(start, end).trim());
        if (json['@type'] === 'Product') {
          const availability = json.offers?.availability || '';
          return {
            inStock: availability.includes('InStock'),
            price: typeof json.offers?.price === 'number' ? json.offers.price : normalizePrice(String(json.offers?.price || '')),
            image: json.image || '',
          };
        }
      } catch (err) { logger.debug(`Pokemon Center: malformed JSON-LD: ${err.message}`); }
      idx = end;
    }
    return null;
  }

  parseNextData(html) {
    const match = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>(.+?)<\/script>/s);
    if (!match) return null;
    try {
      const data = JSON.parse(match[1]);
      const pp = data?.props?.pageProps;
      if (!pp) return null;
      const product = pp.product || pp.productData || pp.initialData?.product;
      if (!product) return null;

      const inStock = product.inStock ?? product.isAvailable ?? (product.availability === 'InStock') ?? null;
      const price = product.price?.amount || product.price || product.offers?.[0]?.price || null;
      const image = product.image?.url || product.images?.[0]?.url || '';

      if (inStock === null) return null;
      return { inStock: !!inStock, price: typeof price === 'number' ? price : normalizePrice(String(price || '')), image };
    } catch (err) {
      logger.debug(`Pokemon Center: __NEXT_DATA__ parse failed: ${err.message}`);
      return null;
    }
  }

  parseHtmlMarkers(html) {
    const lower = html.toLowerCase();
    const outOfStock = lower.includes('out of stock') || lower.includes('sold out') ||
      lower.includes('currently unavailable') || lower.includes('"outofstock"');
    const hasAddToCart = lower.includes('add to cart') || lower.includes('add to bag');

    if (!outOfStock && !hasAddToCart) return null;

    const priceMatch = html.match(/\$\s*([\d,]+\.?\d*)/);
    const price = priceMatch ? normalizePrice(priceMatch[1]) : null;

    return {
      inStock: outOfStock ? false : true,
      price,
      image: '',
    };
  }
}

module.exports = PokemonCenterAdapter;
