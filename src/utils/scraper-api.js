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

// Budget monitoring.
const MONTHLY_BUDGET = parseInt(process.env.SCRAPER_BUDGET) || 100000;
const WARN_THRESHOLD = 0.80;  // warn admin at 80%
const PAUSE_THRESHOLD = 0.90; // pause scraping at 90%
let budgetPaused = false;
let budgetWarned = false;

// Authoritative usage from ScraperAPI's own /account endpoint — this is the BILLED truth.
// Our local creditUsage counter drifts and reset once (read ~30k while the dashboard was 145k),
// which left the pause guard blind. We now anchor pause/warn to the real figure and only fall
// back to the local counter if the account call has never succeeded. Refreshed at most once per
// TTL, so it costs a handful of (free) account calls per hour, never a scrape credit.
let dashboardUsed = null;   // requestCount from /account
let dashboardLimit = null;  // requestLimit from /account (authoritative over SCRAPER_BUDGET)
let lastAccountFetch = 0;
const ACCOUNT_TTL_MS = 5 * 60 * 1000;

/**
 * Pull real usage from ScraperAPI's account endpoint. Throttled to ACCOUNT_TTL_MS. Never throws
 * and never blocks a scrape: on any failure it keeps the last known figure (or leaves it null so
 * checkBudget falls back to the local counter).
 */
async function refreshAccountUsage(force = false) {
  if (!SCRAPER_API_KEY) return;
  const now = Date.now();
  if (!force && now - lastAccountFetch < ACCOUNT_TTL_MS) return;
  lastAccountFetch = now;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${SCRAPER_API_BASE}/account?api_key=${SCRAPER_API_KEY}`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.requestCount === 'number') dashboardUsed = data.requestCount;
    if (typeof data.requestLimit === 'number') dashboardLimit = data.requestLimit;
    checkBudget(); // re-evaluate pause/warn against the real numbers immediately
  } catch {
    // Keep the last known values; the local counter still guards in the meantime.
  }
}

/** The billed figure when we have it, else the local counter. */
function effectiveUsage() {
  const used = dashboardUsed != null ? dashboardUsed : creditUsage.total;
  const limit = dashboardLimit != null ? dashboardLimit : MONTHLY_BUDGET;
  return { used, limit, source: dashboardUsed != null ? 'dashboard' : 'local' };
}

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
    // Binary responses (product images) MUST NOT go through response.text(): a JPEG's first
    // byte 0x89/0xFF is not valid UTF-8, gets replaced with U+FFFD, and the file is destroyed
    // irreversibly (this is the "271KB blob for a 151KB JPEG" we saw). arrayBuffer() preserves
    // the bytes exactly. Verified 2026-09-08.
    binary = false,
    render = true,
    premium = true,
    ultraPremium = false,
    // ScraperAPI geotargeting note: this account's plan does NOT include Canada. A request with
    // country_code=ca returns 403 "Your plan does not include geotargeting for this country",
    // verified directly against the API. Every Canadian retailer we hit is on a .ca domain or a
    // locale-scoped URL (pokemoncenter.com/en-ca/...), and both were checked to return CAD from a
    // US exit IP, so 'us' is the correct working default here — not a compromise on currency.
    country = 'us',
    timeoutMs = 60000,
    retailerId = 'unknown',
    // The 5-minute floor below is sized for 25-credit ultra_premium calls against a 100K
    // budget. A caller making 1-credit standard calls is governed by its own poll interval
    // instead, so it can lower this — the budget guard above still applies either way.
    minIntervalMs = MIN_INTERVAL_MS,
  } = opts;

  await restoreBudget();
  await refreshAccountUsage(); // throttled; anchors the pause guard to the real billed figure

  // Budget check — pause scraping if over threshold
  if (budgetPaused) {
    logger.debug(`ScraperAPI: budget paused (${creditUsage.total}/${MONTHLY_BUDGET} credits used)`);
    return null;
  }

  // Rate limit: skip if called too recently for this retailer
  const now = Date.now();
  const lastCall = lastCallByRetailer.get(retailerId) || 0;
  if (now - lastCall < minIntervalMs) {
    const waitSec = Math.round((minIntervalMs - (now - lastCall)) / 1000);
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
      headers: { 'Accept': binary ? 'image/avif,image/webp,image/png,image/*,*/*' : 'text/html' },
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

    const payload = binary
      ? Buffer.from(await response.arrayBuffer())
      : await response.text();

    // Track credits + budget monitoring
    creditUsage.total += cost;
    creditUsage.byRetailer[retailerId] = (creditUsage.byRetailer[retailerId] || 0) + cost;
    checkBudget();
    persistBudget();

    logger.info(`ScraperAPI: OK for ${retailerId} (${tier}, ${cost} credits, session total: ${creditUsage.total}${binary ? `, ${payload.length}B binary` : ''})`);

    return payload;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`ScraperAPI: timeout after ${timeoutMs}ms for ${targetUrl.substring(0, 80)}`);
    }
    throw err;
  }
}

function checkBudget() {
  const { used, limit } = effectiveUsage();
  const pct = used / limit;
  if (pct >= PAUSE_THRESHOLD && !budgetPaused) {
    budgetPaused = true;
    logger.error(`ScraperAPI BUDGET PAUSED: ${used}/${limit} credits (${(pct * 100).toFixed(0)}%). Scraping halted to prevent overage.`);
  } else if (pct >= WARN_THRESHOLD && !budgetWarned) {
    budgetWarned = true;
    logger.warn(`ScraperAPI BUDGET WARNING: ${used}/${limit} credits (${(pct * 100).toFixed(0)}%). Approaching limit.`);
  }
}

function getBudgetStatus() {
  const { used, limit, source } = effectiveUsage();
  const pct = used / limit;
  return {
    used,
    budget: limit,
    pct: parseFloat((pct * 100).toFixed(1)),
    warned: budgetWarned,
    paused: budgetPaused,
    source,        // 'dashboard' = real billed figure, 'local' = fallback counter
    localTotal: creditUsage.total, // kept for attribution/debugging
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
  await refreshAccountUsage(); // throttled; anchors the pause guard to the real billed figure
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
    country_code: 'us', // plan has no CA geotargeting — see note above
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
  await refreshAccountUsage(); // throttled; anchors the pause guard to the real billed figure
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
    country_code: 'us', // plan has no CA geotargeting — see note above
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

/**
 * Fetch one Amazon ASIN's live offers via ScraperAPI's STRUCTURED endpoint (~1 credit).
 *
 * Replaces the ~10-18 credit AOD / product-page fetch for stock + identity + price + seller.
 * Returns the RAW parsed JSON — { item:{name,image}, listings:[{price, seller_name,
 * fullfilled_by_amazon, pinned_offer, ...}] } — for the caller to interpret. Stock is decided by
 * the PINNED offer carrying a numeric price (parseOffers in amazon-verify.js), NOT listings.length.
 * The payload carries NO offer-listing id, so OLID for one-click ATC links still comes from the
 * cache or a rare /dp/ fetch.
 *
 * Never throws. Returns null on: no key, budget paused, HTTP error (403 still-blocked / 429
 * exhausted), timeout, or non-JSON. Every caller reads null safely — the verifier as
 * "inconclusive" (fail open, fire the alert), price-fill as "leave the tile as-is".
 */
async function fetchAmazonOffers(asin, { timeoutMs = 8000 } = {}) {
  if (!SCRAPER_API_KEY) return null;
  await restoreBudget();
  await refreshAccountUsage(); // throttled; anchors the pause guard to the real billed figure
  if (budgetPaused) return null;

  // Structured Amazon offers endpoint: JSON. `tld=ca` is LOAD-BEARING and silent:
  // it selects the amazon.ca marketplace so prices come back in CAD, but the payload's
  // price_symbol is a bare "$" with nothing marking CAD vs USD. Omit or mistype tld and you get
  // amazon.com prices — ~35% low, entirely plausible, invisible in review — AND no pinned offer,
  // so a wrong tld corrupts BOTH price and stock. Measured: tld=ca returns the CAD pinned price
  // that matches our catalogue; tld=com returns lower USD prices with no pinned offer. Never drop
  // tld=ca. `country` is not needed (tld alone selects the marketplace).
  const params = new URLSearchParams({ api_key: SCRAPER_API_KEY, asin, tld: 'ca' });
  const apiUrl = `${SCRAPER_API_BASE}/structured/amazon/offers?${params}`;
  // 5 credits, MEASURED from the ScraperAPI domain report (amazon.ca = 5.0/req; all Amazon
  // structured endpoints bill 5, the e-commerce rate). This was hard-coded 1 and under-counted the
  // Amazon lanes 5× — the local counter read ~53k while the dashboard billed ~337k. The pause guard
  // anchors to the real /account figure so nothing overran blindly, but every local cap keyed off
  // this number (offers/priority daily caps, burst caps) was 5× too loose. Do not revert to 1.
  const cost = 5;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      logger.debug(`ScraperAPI offers: HTTP ${response.status} for ${asin}`);
      return null;
    }
    const data = await response.json();

    creditUsage.total += cost;
    creditUsage.byRetailer['amazon-offers'] = (creditUsage.byRetailer['amazon-offers'] || 0) + cost;
    checkBudget();
    persistBudget();

    return data; // raw JSON — caller applies the pinned-offer stock rule
  } catch (err) {
    clearTimeout(timer);
    logger.debug(`ScraperAPI offers: ${err.name === 'AbortError' ? 'timeout' : err.message} for ${asin}`);
    return null;
  }
}

/**
 * Adapter for verifyAmazonListing's injected fetcher(url) contract: pull the ASIN out of a /dp/ (or
 * ?asin=) URL and fetch its structured offers, returning the JSON object (parseOffers path) or null.
 */
async function offersFetcher(url, opts = {}) {
  const asin = (String(url).match(/\/dp\/([A-Z0-9]{10})/) || [])[1]
    || (String(url).match(/[?&]asin=([A-Z0-9]{10})/) || [])[1];
  if (!asin) return null;
  return fetchAmazonOffers(asin, opts);
}

function isConfigured() {
  return !!SCRAPER_API_KEY;
}

module.exports = {
  scraperFetch, amazonSearch, fetchAmazonOlidAndSeller, fetchAmazonOffers, offersFetcher,
  getBudgetStatus, restoreBudget, refreshAccountUsage, isConfigured,
};
