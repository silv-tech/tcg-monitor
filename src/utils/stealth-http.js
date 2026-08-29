const logger = require('../monitoring/logger');
const { sleep } = require('./helpers');

let gotScraping;

async function getGotScraping() {
  if (!gotScraping) {
    // got-scraping is ESM-only, must use dynamic import
    const mod = await import('got-scraping');
    gotScraping = mod.gotScraping;
  }
  return gotScraping;
}

/**
 * Stealth HTTP GET with browser-like TLS fingerprinting.
 * Uses got-scraping which randomizes JA3/JA4 fingerprints to mimic real browsers.
 * Use this for sites with Akamai, Incapsula, PerimeterX, or Cloudflare bot detection.
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

  const got = await getGotScraping();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await got({
        url,
        proxyUrl: proxyUrl || undefined,
        timeout: { request: timeoutMs },
        headers: {
          'accept-language': 'en-CA,en-US;q=0.9,en;q=0.8',
          ...headers,
        },
        // Use Chrome-like fingerprint
        headerGeneratorOptions: {
          browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 127 }],
          devices: ['desktop'],
          operatingSystems: ['windows'],
          locales: ['en-CA', 'en-US'],
        },
        responseType: json ? 'json' : 'text',
        retry: { limit: 0 }, // We handle retries ourselves
      });

      if (response.statusCode === 429) {
        const retryAfter = parseInt(response.headers['retry-after'] || '5') * 1000;
        logger.warn(`Stealth: rate limited on ${url}, waiting ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (response.statusCode === 403 || response.statusCode === 503) {
        logger.warn(`Stealth: blocked (${response.statusCode}) on ${url}, attempt ${attempt}/${maxRetries}`);
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`Blocked after ${maxRetries} stealth attempts: ${response.statusCode}`);
      }

      return response.body;
    } catch (err) {
      if (err.message?.includes('Blocked after')) throw err;

      logger.warn(`Stealth: error on ${url}: ${err.message}, attempt ${attempt}/${maxRetries}`);
      if (attempt === maxRetries) throw err;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error(`Stealth: failed after ${maxRetries} attempts: ${url}`);
}

module.exports = { stealthGet };
