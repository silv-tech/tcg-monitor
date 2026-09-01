const logger = require('../monitoring/logger');

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';
const SCRAPER_API_BASE = 'https://api.scraperapi.com';

// Credit costs per tier
const CREDIT_COSTS = {
  standard: 1,
  render: 5,
  premium: 10,
  ultra_premium: 25,
};

// Track credit usage per session
const creditUsage = { total: 0, byRetailer: {}, sessionStart: Date.now() };

// Rate limiter: prevent excessive ScraperAPI calls (costs money)
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between ScraperAPI calls per retailer
const lastCallByRetailer = new Map(); // retailerId → timestamp

/**
 * Fetch a URL through ScraperAPI's anti-bot proxy network.
 * Rate-limited to 1 call per 5 minutes per retailer to control costs.
 *
 * @param {string} targetUrl - The URL to scrape
 * @param {object} opts - Options
 * @param {boolean} opts.render - Enable JS rendering (5 credits)
 * @param {boolean} opts.premium - Enable premium anti-bot (10 credits)
 * @param {boolean} opts.ultraPremium - Enable ultra premium (25 credits)
 * @param {string} opts.country - Country code for geo-targeting (default: 'ca')
 * @param {number} opts.timeoutMs - Request timeout (default: 60000)
 * @param {string} opts.retailerId - For credit tracking and rate limiting
 * @returns {string|null} HTML content, or null if rate-limited
 */
async function scraperFetch(targetUrl, opts = {}) {
  if (!SCRAPER_API_KEY) {
    throw new Error('SCRAPER_API_KEY not configured');
  }

  const {
    render = true,
    premium = true,
    ultraPremium = false,
    country = 'ca',
    timeoutMs = 60000,
    retailerId = 'unknown',
  } = opts;

  // Rate limit: skip if called too recently for this retailer
  const now = Date.now();
  const lastCall = lastCallByRetailer.get(retailerId) || 0;
  if (now - lastCall < MIN_INTERVAL_MS) {
    const waitSec = Math.round((MIN_INTERVAL_MS - (now - lastCall)) / 1000);
    logger.debug(`ScraperAPI: rate-limited for ${retailerId}, next call in ${waitSec}s`);
    return null;
  }
  lastCallByRetailer.set(retailerId, now);

  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    url: targetUrl,
    country_code: country,
  });

  if (render) params.set('render', 'true');
  if (ultraPremium) {
    params.set('ultra_premium', 'true');
  } else if (premium) {
    params.set('premium', 'true');
  }

  const apiUrl = `${SCRAPER_API_BASE}?${params}`;

  // Determine credit cost
  let tier = 'standard';
  if (ultraPremium) tier = 'ultra_premium';
  else if (premium) tier = 'premium';
  else if (render) tier = 'render';
  const cost = CREDIT_COSTS[tier];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'text/html' },
    });

    clearTimeout(timeout);

    if (response.status === 403) {
      throw new Error(`ScraperAPI: 403 — site still blocked (may need ultra_premium tier)`);
    }
    if (response.status === 429) {
      throw new Error(`ScraperAPI: 429 — API rate limit or credits exhausted`);
    }
    if (!response.ok) {
      throw new Error(`ScraperAPI: HTTP ${response.status} ${response.statusText}`);
    }

    const html = await response.text();

    // Track credits
    creditUsage.total += cost;
    creditUsage.byRetailer[retailerId] = (creditUsage.byRetailer[retailerId] || 0) + cost;

    logger.info(`ScraperAPI: OK for ${retailerId} (${tier}, ${cost} credits, session total: ${creditUsage.total})`);

    return html;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`ScraperAPI: timeout after ${timeoutMs}ms for ${targetUrl.substring(0, 80)}`);
    }
    throw err;
  }
}

function getCreditUsage() {
  return { ...creditUsage };
}

function isConfigured() {
  return !!SCRAPER_API_KEY;
}

module.exports = { scraperFetch, getCreditUsage, isConfigured };
