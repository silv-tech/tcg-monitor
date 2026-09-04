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

// Track credit usage — persisted to Redis so budget survives restarts
const creditUsage = { total: 0, byRetailer: {}, sessionStart: Date.now() };
const REDIS_BUDGET_KEY = 'tcg:scraper_budget';

// Budget monitoring — Hobby plan = 100K credits/month
const MONTHLY_BUDGET = parseInt(process.env.SCRAPER_BUDGET) || 100000;
const WARN_THRESHOLD = 0.80;  // warn admin at 80%
const PAUSE_THRESHOLD = 0.90; // pause scraping at 90%
let budgetPaused = false;
let budgetWarned = false;

// Restore budget from Redis on startup (lazy — first call triggers restore)
let _budgetRestored = false;
async function restoreBudget() {
  if (_budgetRestored) return;
  _budgetRestored = true;
  try {
    const state = require('../core/state');
    const raw = await state.getRedis().get(REDIS_BUDGET_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Only restore if same month (reset on new month)
      const savedMonth = new Date(saved.sessionStart).getMonth();
      const currentMonth = new Date().getMonth();
      if (savedMonth === currentMonth) {
        creditUsage.total = saved.total || 0;
        creditUsage.byRetailer = saved.byRetailer || {};
        creditUsage.sessionStart = saved.sessionStart;
        budgetPaused = saved.paused || false;
        budgetWarned = saved.warned || false;
        logger.info(`ScraperAPI: restored budget from Redis — ${creditUsage.total}/${MONTHLY_BUDGET} credits used`);
      } else {
        logger.info('ScraperAPI: new month — budget counter reset');
      }
    }
  } catch (err) {
    logger.warn(`ScraperAPI: failed to restore budget from Redis: ${err.message}`);
  }
}

// Persist budget to Redis (called after each credit spend)
async function persistBudget() {
  try {
    const state = require('../core/state');
    await state.getRedis().set(REDIS_BUDGET_KEY, JSON.stringify({
      total: creditUsage.total,
      byRetailer: creditUsage.byRetailer,
      sessionStart: creditUsage.sessionStart,
      paused: budgetPaused,
      warned: budgetWarned,
    }), 'EX', 86400 * 35); // 35-day TTL (covers a full month + buffer)
  } catch {
    // Non-critical — budget tracking degrades gracefully
  }
}

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

  await restoreBudget();

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
    persistBudget();

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
  await restoreBudget();
  if (budgetPaused) return null;

  const { retailerId = 'amazon' } = opts;

  // Rate limit
  const now = Date.now();
  const lastCall = lastCallByRetailer.get(`${retailerId}:${query}`) || 0;
  if (now - lastCall < MIN_INTERVAL_MS) {
    logger.debug(`ScraperAPI: rate-limited Amazon search "${query}" for ${retailerId}`);
    return null;
  }
  lastCallByRetailer.set(`${retailerId}:${query}`, now);

  // Use autoparse with full URL (same approach as Walmart) — allows emi= seller filter
  // A3DWYIK6Y9EEQB = Amazon.ca's seller ID — filters to "sold by Amazon" only
  const targetUrl = `https://www.amazon.ca/s?k=${encodeURIComponent(query)}&emi=A3DWYIK6Y9EEQB`;
  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    url: targetUrl,
    autoparse: 'true',
    country_code: 'ca',
  });

  const apiUrl = `${SCRAPER_API_BASE}?${params}`;
  const cost = 5; // E-commerce domains cost 5 credits

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
    persistBudget();
    logger.info(`ScraperAPI: Amazon search OK "${query}" (${cost} credits, session total: ${creditUsage.total})`);

    return data;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error(`ScraperAPI Amazon search: timeout for "${query}"`);
    throw err;
  }
}

/**
 * Fetch Amazon Offer Listing ID + seller via Amazon's AOD (All Offers Display) endpoint.
 * Routed through ScraperAPI premium proxy. Returns the OLID from the pinned (Buy Box)
 * offer, or the first listed offer if no Buy Box winner exists.
 * 10 credits per call (premium proxy). Rate-limited per ASIN (5-min cooldown).
 *
 * @param {string} asin - Amazon ASIN
 * @returns {{ olid: string|null, seller: string|null }}
 */
async function fetchAmazonOlidAndSeller(asin) {
  if (!SCRAPER_API_KEY) return { olid: null, seller: null };
  await restoreBudget();
  if (budgetPaused) return { olid: null, seller: null };

  // Rate limit per ASIN — don't re-fetch same ASIN within 5 minutes
  const rateKey = `amazon-olid-${asin}`;
  const now = Date.now();
  const lastCall = lastCallByRetailer.get(rateKey) || 0;
  if (now - lastCall < MIN_INTERVAL_MS) return { olid: null, seller: null };
  lastCallByRetailer.set(rateKey, now);

  // Fetch Amazon's AOD (All Offers Display) page via ScraperAPI premium proxy
  // This internal AJAX endpoint returns HTML with offerListingId values per seller
  const targetUrl = `https://www.amazon.ca/gp/product/ajax/aodAjaxMain/?asin=${asin}`;
  const params = new URLSearchParams({
    api_key: SCRAPER_API_KEY,
    url: targetUrl,
    premium: 'true',
    country_code: 'ca',
  });

  const apiUrl = `${SCRAPER_API_BASE}?${params}`;
  const cost = 10; // Premium proxy tier

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`ScraperAPI AOD: HTTP ${response.status}`);
    }

    const html = await response.text();

    creditUsage.total += cost;
    creditUsage.byRetailer['amazon-olid'] = (creditUsage.byRetailer['amazon-olid'] || 0) + cost;
    checkBudget();
    persistBudget();

    let olid = null;
    let seller = null;

    // 1) Try pinned offer first (Buy Box winner — this is the Amazon.ca direct offer)
    const pinnedMatch = html.match(/aod-pinned-offer([\s\S]*?)(?=aod-offer-list|$)/);
    if (pinnedMatch) {
      const pinnedBlock = pinnedMatch[1];
      const pinnedOlid = pinnedBlock.match(/offerListingId\]\s*"\s*value="([^"]+)"/);
      if (pinnedOlid && pinnedOlid[1]) {
        olid = pinnedOlid[1];
      }
      const pinnedSeller = pinnedBlock.match(/aod-offer-soldBy[\s\S]*?<a[^>]*role="link"[^>]*>([^<]+)<\/a>/);
      if (pinnedSeller) {
        seller = pinnedSeller[1].trim();
      }
    }

    // 2) If no pinned OLID, grab the first listed offer's OLID
    if (!olid) {
      const firstOlid = html.match(/offerListingId\]\s*"\s*value="([^"]+)"/);
      if (firstOlid && firstOlid[1]) {
        olid = firstOlid[1];
      }
    }

    // 3) If no pinned seller, grab first seller from offer list
    if (!seller) {
      const sellerMatches = [...html.matchAll(/aod-offer-soldBy[\s\S]*?<a[^>]*role="link"[^>]*>([^<]+)<\/a>/g)];
      if (sellerMatches.length > 0) {
        seller = sellerMatches[0][1].trim();
      }
    }

    // Count total offers for logging
    const totalOlids = (html.match(/offerListingId\]\s*"\s*value="[^"]+"/g) || []).length;

    if (olid) logger.info(`ScraperAPI AOD: OLID for ${asin}: ${olid.substring(0, 30)}... (${totalOlids} total offers)`);
    if (seller) logger.info(`ScraperAPI AOD: Seller for ${asin}: ${seller}`);
    if (!olid && !seller) {
      logger.debug(`ScraperAPI AOD: no OLID/seller found for ${asin} (page size: ${html.length})`);
    }

    return { olid, seller };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      logger.debug(`ScraperAPI AOD: timeout for ${asin}`);
    } else {
      logger.debug(`ScraperAPI AOD: failed for ${asin}: ${err.message}`);
    }
    return { olid: null, seller: null };
  }
}

function isConfigured() {
  return !!SCRAPER_API_KEY;
}

module.exports = { scraperFetch, amazonSearch, fetchAmazonOlidAndSeller, getBudgetStatus, isConfigured };
