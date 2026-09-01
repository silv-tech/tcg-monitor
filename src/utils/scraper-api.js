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

// Budget monitoring — Hobby plan = 100K credits/month
const MONTHLY_BUDGET = parseInt(process.env.SCRAPER_BUDGET) || 100000;
const WARN_THRESHOLD = 0.80;  // warn admin at 80%
const PAUSE_THRESHOLD = 0.90; // pause scraping at 90%
let budgetPaused = false;
let budgetWarned = false;

// Rate limiter: prevent excessive ScraperAPI calls (costs money)
// Budget: 100K credits/month on Hobby plan ($49/mo)
// Structured endpoints: 9 queries × 5 credits × 2/hr × 24h × 30d = 64,800 credits
// Pokemon Center: 25 credits × 2/hr × 24h × 30d = 36,000 credits
// Total: ~100,800/month — right at budget
const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between ScraperAPI calls per query
const lastCallByRetailer = new Map(); // retailerId → timestamp

/**
 * Fetch a URL through ScraperAPI's anti-bot proxy network.
 * Rate-limited to 1 call per 20 minutes per retailer to control costs.
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

  // Budget check — pause scraping if over threshold
  if (budgetPaused) {
    logger.debug(`ScraperAPI: budget paused (${creditUsage.total}/${MONTHLY_BUDGET} credits used)`);
    return null;
  }

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

    // Track credits + budget monitoring
    creditUsage.total += cost;
    creditUsage.byRetailer[retailerId] = (creditUsage.byRetailer[retailerId] || 0) + cost;
    checkBudget();

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

function checkBudget() {
  const pct = creditUsage.total / MONTHLY_BUDGET;
  if (pct >= PAUSE_THRESHOLD && !budgetPaused) {
    budgetPaused = true;
    logger.error(`ScraperAPI BUDGET PAUSED: ${creditUsage.total}/${MONTHLY_BUDGET} credits (${(pct * 100).toFixed(0)}%). Scraping halted to prevent overage.`);
  } else if (pct >= WARN_THRESHOLD && !budgetWarned) {
    budgetWarned = true;
    logger.warn(`ScraperAPI BUDGET WARNING: ${creditUsage.total}/${MONTHLY_BUDGET} credits (${(pct * 100).toFixed(0)}%). Approaching limit.`);
  }
}

function getCreditUsage() {
  return { ...creditUsage };
}

function getBudgetStatus() {
  const pct = creditUsage.total / MONTHLY_BUDGET;
  return {
    used: creditUsage.total,
    budget: MONTHLY_BUDGET,
    pct: parseFloat((pct * 100).toFixed(1)),
    warned: budgetWarned,
    paused: budgetPaused,
  };
}

function resetBudget() {
  creditUsage.total = 0;
  creditUsage.byRetailer = {};
  creditUsage.sessionStart = Date.now();
  budgetPaused = false;
  budgetWarned = false;
  logger.info('ScraperAPI budget counters reset');
}

/**
 * ScraperAPI Structured Data Endpoints — purpose-built for e-commerce sites.
 * These handle anti-bot automatically at 5 credits/request (vs 10-25 for generic scraping).
 * Returns clean JSON instead of raw HTML.
 */

/**
 * Search Amazon via ScraperAPI structured endpoint.
 * @param {string} query - Search query (e.g., "pokemon tcg booster box")
 * @param {object} opts
 * @param {string} opts.tld - Amazon TLD (default: 'ca' for amazon.ca)
 * @param {string} opts.retailerId - For credit tracking and rate limiting
 * @returns {object|null} Parsed JSON response, or null if rate-limited
 */
async function amazonSearch(query, opts = {}) {
  if (!SCRAPER_API_KEY) throw new Error('SCRAPER_API_KEY not configured');
  if (budgetPaused) return null;

  const { tld = 'ca', retailerId = 'amazon' } = opts;

  // Rate limit
  const now = Date.now();
  const lastCall = lastCallByRetailer.get(`${retailerId}:${query}`) || 0;
  if (now - lastCall < MIN_INTERVAL_MS) {
    logger.debug(`ScraperAPI: rate-limited Amazon search "${query}" for ${retailerId}`);
    return null;
  }
  lastCallByRetailer.set(`${retailerId}:${query}`, now);

  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    query,
    tld,
    country_code: tld,
  });

  const apiUrl = `${SCRAPER_API_BASE}/structured/amazon/search?${params}`;
  const cost = 5; // Structured e-commerce endpoints cost 5 credits

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`ScraperAPI Amazon search: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    creditUsage.total += cost;
    creditUsage.byRetailer[retailerId] = (creditUsage.byRetailer[retailerId] || 0) + cost;
    checkBudget();
    logger.info(`ScraperAPI: Amazon search OK "${query}" (${cost} credits, session total: ${creditUsage.total})`);

    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error(`ScraperAPI Amazon search: timeout for "${query}"`);
    throw err;
  }
}

/**
 * Search Walmart via ScraperAPI structured endpoint.
 * @param {string} query - Search query (e.g., "pokemon tcg")
 * @param {object} opts
 * @param {string} opts.tld - Walmart TLD (default: 'ca' for walmart.ca)
 * @param {string} opts.retailerId - For credit tracking and rate limiting
 * @returns {object|null} Parsed JSON response, or null if rate-limited
 */
async function walmartSearch(query, opts = {}) {
  if (!SCRAPER_API_KEY) throw new Error('SCRAPER_API_KEY not configured');
  if (budgetPaused) return null;

  const { retailerId = 'walmart' } = opts;

  // Rate limit
  const now = Date.now();
  const lastCall = lastCallByRetailer.get(`${retailerId}:${query}`) || 0;
  if (now - lastCall < MIN_INTERVAL_MS) {
    logger.debug(`ScraperAPI: rate-limited Walmart search "${query}" for ${retailerId}`);
    return null;
  }
  lastCallByRetailer.set(`${retailerId}:${query}`, now);

  // Use autoparse with full walmart.ca URL — structured endpoint doesn't support
  // Canada geo on the Hobby plan, but autoparse with the .ca URL works fine
  const targetUrl = `https://www.walmart.ca/search?q=${encodeURIComponent(query)}`;
  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    url: targetUrl,
    autoparse: 'true',
  });

  const apiUrl = `${SCRAPER_API_BASE}?${params}`;
  const cost = 5; // E-commerce domains cost 5 credits

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`ScraperAPI Walmart search: HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    creditUsage.total += cost;
    creditUsage.byRetailer[retailerId] = (creditUsage.byRetailer[retailerId] || 0) + cost;
    checkBudget();
    logger.info(`ScraperAPI: Walmart search OK "${query}" (${cost} credits, session total: ${creditUsage.total})`);

    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error(`ScraperAPI Walmart search: timeout for "${query}"`);
    throw err;
  }
}

function isConfigured() {
  return !!SCRAPER_API_KEY;
}

module.exports = { scraperFetch, amazonSearch, walmartSearch, getCreditUsage, getBudgetStatus, resetBudget, isConfigured };
