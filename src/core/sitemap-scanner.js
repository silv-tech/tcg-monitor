/**
 * Early SKU Detection — Multi-retailer sitemap scanner.
 *
 * Scans retailer sitemaps every 12h, diffs against Redis baselines,
 * and fires EARLY_SKU events for new TCG products found before they
 * appear in search results or get stocked.
 *
 * Supported retailers:
 *   - Walmart CA: index → 5 gzipped child sitemaps (~218K product URLs)
 *   - Pokemon Center: single plain XML sitemap (~34K product URLs)
 *
 * Uses the same stealth HTTP (impit + residential proxy) that already
 * bypasses bot protection in our adapters.
 */

const { promisify } = require('util');
const zlib = require('zlib');
const logger = require('../monitoring/logger');
const state = require('./state');
const { stealthGet, _clearCache } = require('../utils/stealth-http');
const { getProxyUrl } = require('./proxy');

const gunzip = promisify(zlib.gunzip);

// Lazy-load impit for binary fetches (gzipped sitemaps)
let _impitModule;
async function getImpit() {
  if (!_impitModule) _impitModule = await import('impit');
  return _impitModule.Impit;
}

const SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ─── Walmart config ──────────────────────────────────────────────
const WALMART_INDEX_URL = 'https://www.walmart.ca/sitemap-product-1p-en.xml';
const WALMART_REDIS_KEY = 'tcg:sitemap:walmart:known';

const WALMART_SLUG_TOKENS = [
  'pokemon-tcg', 'pokemon-trading-card', 'pokemon-booster', 'pokemon-elite-trainer',
  'pokemon-collection-box', 'pokemon-tin', 'pokemon-blister', 'pokemon-premium',
  'pokemon-build-battle', 'pokemon-bundle', 'pokemon-ex-box', 'pokemon-ex-premium',
  'pokemon-ex-collection', 'pokemon-v-box', 'pokemon-vmax', 'pokemon-vstar',
  'pok-mon-tcg', 'pok-mon-booster', 'pok-mon-elite-trainer', 'pok-mon-collection',
  'pok-mon-premium', 'pokmon-tcg',
  'prismatic-evolutions', 'surging-sparks', 'twilight-masquerade',
  'shrouded-fable', 'stellar-crown', 'paldea-evolved', 'obsidian-flames',
  'paradox-rift', 'temporal-forces', 'journey-together', 'destined-rivals',
  'one-piece-card', 'one-piece-tcg', 'yu-gi-oh', 'magic-gathering', 'lorcana',
];

// ─── Pokemon Center config ───────────────────────────────────────
const PC_SITEMAP_URL = 'https://www.pokemoncenter.com/sitemaps/products.xml';
const PC_REDIS_KEY = 'tcg:sitemap:pokemoncenter:known';

const PC_TCG_KEYWORDS = [
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
  'silver-tempest', 'crown-zenith', 'journey-together', 'destined-rivals',
];

// ─── Shared helpers ──────────────────────────────────────────────

function extractLocs(xml) {
  const matches = [];
  const re = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

/**
 * Diff a list of URLs against a Redis Set. Returns new URLs not in the set.
 * Adds all URLs to the set (seeds on first run).
 */
async function diffUrls(urls, redisKey) {
  const redis = state.getRedis();
  const knownCount = await redis.scard(redisKey);
  const isFirstRun = knownCount === 0;

  const newUrls = [];
  for (let i = 0; i < urls.length; i += 1000) {
    const batch = urls.slice(i, i + 1000);
    if (!isFirstRun) {
      const pipeline = redis.pipeline();
      batch.forEach(url => pipeline.sismember(redisKey, url));
      const results = await pipeline.exec();
      for (let j = 0; j < batch.length; j++) {
        const [err, isMember] = results[j];
        if (!err && !isMember) newUrls.push(batch[j]);
      }
    }
    await redis.sadd(redisKey, ...batch);
  }

  await redis.expire(redisKey, 86400 * 30); // 30-day TTL
  return { newUrls, isFirstRun };
}

// ─── Walmart functions ───────────────────────────────────────────

function walmartExtractSlug(url) {
  const parts = url.split('/ip/');
  if (parts.length < 2) return '';
  const segments = parts[1].replace(/\/$/, '').split('/');
  return segments.length >= 2 ? segments[0].toLowerCase() : '';
}

function walmartExtractSku(url) {
  const clean = url.split('?')[0].split('#')[0].replace(/\/$/, '');
  const segments = clean.split('/');
  const last = segments[segments.length - 1];
  return /^[A-Za-z0-9]{10,15}$/.test(last) ? last : null;
}

function isWalmartTCG(url) {
  const slug = walmartExtractSlug(url);
  if (!slug) return false;
  return WALMART_SLUG_TOKENS.some(token => slug.includes(token));
}

async function fetchSitemapXml(url) {
  const proxyUrl = getProxyUrl('residential');
  try {
    const xml = await stealthGet(url, {
      proxyUrl,
      maxRetries: 3,
      timeoutMs: 30000,
      headers: { 'Accept': 'application/xml, text/xml, */*' },
    });
    if (!xml || xml.length < 100) return null;
    return xml;
  } catch (err) {
    logger.error(`Early SKU: Fetch error (${url}): ${err.message}`);
    if (proxyUrl) _clearCache(proxyUrl);
    return null;
  }
}

async function fetchSitemapGz(url) {
  const proxyUrl = getProxyUrl('residential');
  try {
    const Impit = await getImpit();
    const impit = new Impit({
      browser: 'chrome',
      proxyUrl: proxyUrl || undefined,
      ignoreTlsErrors: false,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await impit.fetch(url, {
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.status !== 200) {
      logger.warn(`Early SKU: HTTP ${response.status} — ${url}`);
      return [];
    }

    const arrayBuf = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    let xmlText;
    try {
      const decompressed = await gunzip(buffer);
      xmlText = decompressed.toString('utf-8');
    } catch {
      xmlText = buffer.toString('utf-8');
    }
    return extractLocs(xmlText);
  } catch (err) {
    logger.warn(`Early SKU: Fetch error: ${err.message} — ${url}`);
    return [];
  }
}

async function scanWalmart() {
  logger.info('Early SKU [Walmart]: scanning sitemaps...');
  const start = Date.now();

  // Fetch index → child URLs
  const indexXml = await fetchSitemapXml(WALMART_INDEX_URL);
  if (!indexXml) {
    logger.error('Early SKU [Walmart]: failed to fetch sitemap index');
    return [];
  }
  const childUrls = extractLocs(indexXml);
  if (childUrls.length === 0) {
    logger.error('Early SKU [Walmart]: no child sitemaps in index');
    return [];
  }
  logger.info(`Early SKU [Walmart]: ${childUrls.length} child sitemaps`);

  // Fetch all child sitemaps (gzipped)
  const allUrls = [];
  for (const childUrl of childUrls) {
    const urls = await fetchSitemapGz(childUrl);
    allUrls.push(...urls);
    logger.info(`  ${childUrl.split('/').pop()}: ${urls.length} URLs`);
  }

  // Diff against Redis
  const { newUrls, isFirstRun } = await diffUrls(allUrls, WALMART_REDIS_KEY);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (isFirstRun) {
    logger.info(`Early SKU [Walmart]: first run — seeded ${allUrls.length} URLs in ${elapsed}s`);
    return [];
  }

  const tcgUrls = newUrls.filter(isWalmartTCG);
  logger.info(`Early SKU [Walmart]: ${elapsed}s — ${newUrls.length} new URLs, ${tcgUrls.length} TCG`);

  return tcgUrls.map(url => {
    const sku = walmartExtractSku(url);
    const slug = walmartExtractSlug(url);
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return {
      type: 'EARLY_SKU',
      product: {
        sku: sku || slug, name, url,
        price: null, inStock: false,
        retailer: 'Walmart Canada', retailerId: 'walmart',
        category: 'pokemon', isTCG: true, _earlyDetection: true,
      },
      detail: 'New product found in Walmart sitemap before search indexing',
      _detectedAt: Date.now(),
    };
  });
}

// ─── Pokemon Center functions ────────────────────────────────────

function pcExtractSku(url) {
  // URL: https://www.pokemoncenter.com/en-ca/product/10-12345-001/pokemon-tcg-product-name
  const parts = url.split('/product/');
  if (parts.length < 2) return null;
  const segments = parts[1].replace(/\/$/, '').split('/');
  return segments[0] || null; // e.g. "10-12345-001"
}

function pcExtractSlug(url) {
  const parts = url.split('/product/');
  if (parts.length < 2) return '';
  const segments = parts[1].replace(/\/$/, '').split('/');
  return segments.length >= 2 ? segments[1].toLowerCase() : '';
}

function isPokemonCenterTCG(url) {
  if (!url.includes('/product/')) return false;
  const slug = pcExtractSlug(url);
  if (!slug) return false;
  return PC_TCG_KEYWORDS.some(kw => slug.includes(kw));
}

async function scanPokemonCenter() {
  logger.info('Early SKU [Pokemon Center]: scanning sitemap...');
  const start = Date.now();

  // Single plain XML sitemap
  const xml = await fetchSitemapXml(PC_SITEMAP_URL);
  if (!xml) {
    logger.error('Early SKU [Pokemon Center]: failed to fetch sitemap');
    return [];
  }

  const allUrls = extractLocs(xml).filter(u => u.includes('/product/'));
  logger.info(`Early SKU [Pokemon Center]: ${allUrls.length} product URLs`);

  // Diff against Redis
  const { newUrls, isFirstRun } = await diffUrls(allUrls, PC_REDIS_KEY);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (isFirstRun) {
    logger.info(`Early SKU [Pokemon Center]: first run — seeded ${allUrls.length} URLs in ${elapsed}s`);
    return [];
  }

  const tcgUrls = newUrls.filter(isPokemonCenterTCG);
  logger.info(`Early SKU [Pokemon Center]: ${elapsed}s — ${newUrls.length} new URLs, ${tcgUrls.length} TCG`);

  return tcgUrls.map(url => {
    const sku = pcExtractSku(url);
    const slug = pcExtractSlug(url);
    const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const caUrl = url.replace(/\/en-[a-z]{2}\/product\//, '/en-ca/product/')
      .replace(/^(https?:\/\/[^/]+)\/product\//, '$1/en-ca/product/');
    return {
      type: 'EARLY_SKU',
      product: {
        sku: sku || slug, name, url: caUrl,
        price: null, inStock: false,
        retailer: 'Pokemon Center', retailerId: 'pokemoncenter',
        category: 'pokemon', isTCG: true, _earlyDetection: true,
      },
      detail: 'New product found in Pokemon Center sitemap',
      _detectedAt: Date.now(),
    };
  });
}

// ─── Main scan (runs both retailers) ─────────────────────────────

async function scanSitemaps() {
  logger.info('=== Early SKU Detection: starting multi-retailer scan ===');
  const allEvents = [];

  // Scan Walmart
  try {
    const walmartEvents = await scanWalmart();
    allEvents.push(...walmartEvents);
  } catch (err) {
    logger.error(`Early SKU [Walmart]: scan failed: ${err.message}`);
  }

  // Scan Pokemon Center
  try {
    const pcEvents = await scanPokemonCenter();
    allEvents.push(...pcEvents);
  } catch (err) {
    logger.error(`Early SKU [Pokemon Center]: scan failed: ${err.message}`);
  }

  logger.info(`=== Early SKU Detection: complete — ${allEvents.length} total alerts ===`);

  // Update last-run timestamp
  const redis = state.getRedis();
  await redis.set('tcg:sitemap:lastrun', Date.now().toString());

  return allEvents;
}

module.exports = { scanSitemaps, SCAN_INTERVAL_MS };
