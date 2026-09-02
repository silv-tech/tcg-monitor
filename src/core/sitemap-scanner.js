/**
 * Early SKU Detection — Walmart CA sitemap scanner.
 *
 * Fetches Walmart's 1P product sitemaps every 12h, diffs against Redis,
 * and fires EARLY_SKU events for new TCG products found before search indexing.
 *
 * Sitemap structure:
 *   https://www.walmart.ca/sitemap-product-1p-en.xml  (index → 5 child .xml.gz files)
 *   Child sitemaps are gzipped XML containing ~40K product URLs each.
 *
 * Redis keys:
 *   tcg:sitemap:known — Set of all previously-seen product URLs
 *   tcg:sitemap:lastrun — timestamp of last successful scan
 */

const { promisify } = require('util');
const zlib = require('zlib');
const fetch = require('node-fetch');
const logger = require('../monitoring/logger');
const state = require('./state');

const gunzip = promisify(zlib.gunzip);

const SITEMAP_INDEX_URL = 'https://www.walmart.ca/sitemap-product-1p-en.xml';
const REDIS_KNOWN_KEY = 'tcg:sitemap:known';
const REDIS_LASTRUN_KEY = 'tcg:sitemap:lastrun';
const SCAN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Slug tokens matched against the product-name portion of URLs only.
const SLUG_TOKENS = [
  // Pokemon TCG (compound to avoid matching clothing/toys/food)
  'pokemon-tcg', 'pokemon-trading-card', 'pokemon-booster', 'pokemon-elite-trainer',
  'pokemon-collection-box', 'pokemon-tin', 'pokemon-blister', 'pokemon-premium',
  'pokemon-build-battle', 'pokemon-bundle', 'pokemon-ex-box', 'pokemon-ex-premium',
  'pokemon-ex-collection', 'pokemon-v-box', 'pokemon-vmax', 'pokemon-vstar',
  'pok-mon-tcg', 'pok-mon-booster', 'pok-mon-elite-trainer', 'pok-mon-collection',
  'pok-mon-premium', 'pokmon-tcg',
  // Set-specific slugs (unique enough standalone)
  'prismatic-evolutions', 'surging-sparks', 'twilight-masquerade',
  'shrouded-fable', 'stellar-crown', 'paldea-evolved', 'obsidian-flames',
  'paradox-rift', 'temporal-forces', 'journey-together', 'destined-rivals',
  // Other TCG brands
  'one-piece-card', 'one-piece-tcg', 'yu-gi-oh', 'magic-gathering', 'lorcana',
];

/**
 * Extract the product slug from a Walmart URL (excluding the SKU ID).
 * URL: https://www.walmart.ca/en/ip/Product-Name-Here/6000XXXXXXXXX
 * Returns: "product-name-here"
 */
function extractSlug(url) {
  const parts = url.split('/ip/');
  if (parts.length < 2) return '';
  const segments = parts[1].replace(/\/$/, '').split('/');
  return segments.length >= 2 ? segments[0].toLowerCase() : '';
}

/**
 * Extract SKU from a Walmart URL (last path segment).
 */
function extractSku(url) {
  const clean = url.split('?')[0].split('#')[0].replace(/\/$/, '');
  const segments = clean.split('/');
  const last = segments[segments.length - 1];
  return /^[A-Za-z0-9]{10,15}$/.test(last) ? last : null;
}

/**
 * Check if a URL's slug matches any TCG token.
 */
function isTCGUrl(url) {
  const slug = extractSlug(url);
  if (!slug) return false;
  return SLUG_TOKENS.some(token => slug.includes(token));
}

/**
 * Extract all <loc>...</loc> values from XML text using regex.
 * Works for both sitemap index and urlset documents.
 */
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
 * Fetch the sitemap index (plain XML) and return child sitemap URLs.
 */
async function fetchSitemapIndex() {
  try {
    const res = await fetch(SITEMAP_INDEX_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/xml, text/xml, */*',
      },
      timeout: 30000,
    });

    if (!res.ok) {
      logger.error(`Sitemap index fetch failed: HTTP ${res.status}`);
      return [];
    }

    const xml = await res.text();
    return extractLocs(xml);
  } catch (err) {
    logger.error(`Sitemap index fetch error: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a gzipped sitemap (.xml.gz) and return product URLs.
 */
async function fetchSitemapGz(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
      timeout: 60000,
    });

    if (!res.ok) {
      logger.warn(`Sitemap fetch failed: HTTP ${res.status} — ${url}`);
      return [];
    }

    const buffer = await res.buffer();

    // Decompress gzip
    let xmlText;
    try {
      const decompressed = await gunzip(buffer);
      xmlText = decompressed.toString('utf-8');
    } catch {
      xmlText = buffer.toString('utf-8');
    }

    return extractLocs(xmlText);
  } catch (err) {
    logger.warn(`Sitemap fetch error: ${err.message} — ${url}`);
    return [];
  }
}

/**
 * Main scan: fetch all sitemaps, diff against Redis, return new TCG events.
 */
async function scanSitemaps() {
  const startTime = Date.now();
  logger.info('=== Early SKU Detection: Walmart sitemap scan starting ===');

  // Step 1: Fetch sitemap index
  const childUrls = await fetchSitemapIndex();
  if (childUrls.length === 0) {
    logger.error('Early SKU: No child sitemaps found in Walmart index');
    return [];
  }
  logger.info(`Early SKU: Sitemap index has ${childUrls.length} child sitemaps`);

  // Step 2: Fetch all child sitemaps
  const allProductUrls = [];
  for (const childUrl of childUrls) {
    const urls = await fetchSitemapGz(childUrl);
    allProductUrls.push(...urls);
    logger.info(`  ${childUrl.split('/').pop()}: ${urls.length} URLs`);
  }
  logger.info(`Early SKU: Total product URLs: ${allProductUrls.length}`);

  // Step 3: Diff against Redis — find truly new URLs
  const redis = state.getRedis();
  const knownCount = await redis.scard(REDIS_KNOWN_KEY);
  const isFirstRun = knownCount === 0;

  const newUrls = [];
  for (let i = 0; i < allProductUrls.length; i += 1000) {
    const batch = allProductUrls.slice(i, i + 1000);
    if (!isFirstRun) {
      const pipeline = redis.pipeline();
      batch.forEach(url => pipeline.sismember(REDIS_KNOWN_KEY, url));
      const results = await pipeline.exec();
      for (let j = 0; j < batch.length; j++) {
        const [err, isMember] = results[j];
        if (!err && !isMember) {
          newUrls.push(batch[j]);
        }
      }
    }
    await redis.sadd(REDIS_KNOWN_KEY, ...batch);
  }

  // 30-day TTL on the known set
  await redis.expire(REDIS_KNOWN_KEY, 86400 * 30);
  await redis.set(REDIS_LASTRUN_KEY, Date.now().toString());

  if (isFirstRun) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Early SKU: First run — seeded ${allProductUrls.length} URLs in ${elapsed}s. No alerts on first run.`);
    return [];
  }

  if (newUrls.length === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`Early SKU: Scan complete in ${elapsed}s — 0 new URLs`);
    return [];
  }

  // Step 4: Filter by TCG slug tokens
  const tcgUrls = newUrls.filter(isTCGUrl);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`Early SKU: Scan complete in ${elapsed}s — ${newUrls.length} new URLs, ${tcgUrls.length} TCG matches`);

  // Step 5: Build events
  return tcgUrls.map(url => {
    const sku = extractSku(url);
    const slug = extractSlug(url);
    const name = slug
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());

    return {
      type: 'EARLY_SKU',
      product: {
        sku: sku || slug,
        name,
        url,
        price: null,
        inStock: false,
        retailer: 'Walmart Canada',
        retailerId: 'walmart',
        category: 'pokemon',
        isTCG: true,
        _earlyDetection: true,
      },
      detail: 'New product found in Walmart sitemap before search indexing',
      _detectedAt: Date.now(),
    };
  });
}

module.exports = { scanSitemaps, isTCGUrl, extractSlug, extractSku, SCAN_INTERVAL_MS };
