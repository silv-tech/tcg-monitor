const logger = require('../monitoring/logger');
const { sleep } = require('./helpers');

let impitModule;

async function getImpit() {
  if (!impitModule) {
    // impit is ESM-only, must use dynamic import
    impitModule = await import('impit');
  }
  return impitModule.Impit;
}

// Cache Impit instances per proxy URL to reuse connections
const impitCache = new Map();

async function getImpitInstance(proxyUrl) {
  const cacheKey = proxyUrl || '__direct__';
  if (impitCache.has(cacheKey)) return impitCache.get(cacheKey);

  const Impit = await getImpit();
  const instance = new Impit({
    browser: 'chrome',
    proxyUrl: proxyUrl || undefined,
    ignoreTlsErrors: false,
  });

  impitCache.set(cacheKey, instance);
  return instance;
}

/**
 * Stealth HTTP GET with real browser TLS fingerprinting.
 * Uses impit (Apify) which spoofs JA3/JA4 fingerprints via Rust/BoringSSL
 * to match real Chrome. Bypasses Imperva Incapsula, Akamai, Cloudflare.
 */
async function stealthGet(url, opts = {}) {
  const {
    proxyUrl = null,
    maxRetries = 3,
    retryDelayMs = 3000,
    timeoutMs = 20000,
    json = false,
    headers = {},
  } = opts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const impit = await getImpitInstance(proxyUrl);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await impit.fetch(url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          ...headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5') * 1000;
        logger.warn(`Stealth: rate limited on ${url}, waiting ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (response.status === 403 || response.status === 503) {
        logger.warn(`Stealth: blocked (${response.status}) on ${url}, attempt ${attempt}/${maxRetries}`);
        // Clear cached instance on block — next attempt gets a fresh connection
        const cacheKey = proxyUrl || '__direct__';
        impitCache.delete(cacheKey);
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`Blocked after ${maxRetries} stealth attempts: ${response.status}`);
      }

      if (json) {
        return await response.json();
      }
      return await response.text();
    } catch (err) {
      if (err.message?.includes('Blocked after')) throw err;

      // Clear cached instance on error
      const cacheKey = proxyUrl || '__direct__';
      impitCache.delete(cacheKey);

      logger.warn(`Stealth: error on ${url}: ${err.message}, attempt ${attempt}/${maxRetries}`);
      if (attempt === maxRetries) throw err;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`Stealth: failed after ${maxRetries} attempts: ${url}`);
}

/**
 * Clear a cached impit instance — forces a new connection (and new IP with rotating proxies).
 */
function _clearCache(proxyUrl) {
  const cacheKey = proxyUrl || '__direct__';
  impitCache.delete(cacheKey);
}

module.exports = { stealthGet, _clearCache };
