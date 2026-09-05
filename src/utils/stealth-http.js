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

/**
 * Per-host rate-limit cooldowns.
 *
 * Thirty Shopify shops on one Railway IP polled in lockstep and took 202 rate-limit
 * rejections in a 23-second window — because a 429 changed nothing. `maxRetries: 1` meant
 * the Retry-After sleep below was never reached (attempt 1 >= 1 throws immediately), so every
 * shop kept firing on its next tick regardless of the retailer asking us to stop.
 *
 * A 429 is the retailer telling us its price for the next N seconds. Honour it at the HOST
 * level: every caller for that host fails fast until the cooldown expires, instead of each
 * one independently rediscovering the block. Failing fast is also what lets the caller
 * distinguish "throttled" from "this shop has no products" — the two were indistinguishable,
 * which is what raised false parser alerts and alert floods on recovery.
 */
const hostCooldowns = new Map(); // host -> epoch ms until which requests fail fast
const MAX_COOLDOWN_MS = 120000;

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function cooldownRemaining(url) {
  const until = hostCooldowns.get(hostOf(url));
  if (!until) return 0;
  const left = until - Date.now();
  if (left <= 0) { hostCooldowns.delete(hostOf(url)); return 0; }
  return left;
}

function setCooldown(url, ms) {
  const host = hostOf(url);
  const until = Date.now() + Math.min(ms, MAX_COOLDOWN_MS);
  // Never shorten an existing cooldown — repeated 429s mean the host wants more room.
  if ((hostCooldowns.get(host) || 0) < until) hostCooldowns.set(host, until);
}

/** True when the error came from a retailer throttling us rather than a parse or block failure. */
function isRateLimited(err) {
  return /^(Rate limited|Cooling down)/.test(err?.message || '');
}

// `lane` splits one proxy URL across several cached impit instances. Each instance keeps its
// own connection, and the residential pool hands out a different exit IP per connection —
// measured: 4 requests through one shared instance all came from 184.65.189.19, while 4
// separate instances came from 4 distinct IPs. Walmart fires its search queries in parallel,
// so without lanes they arrive at PerimeterX as a burst from a single address.
function instanceKey(proxyUrl, ignoreTlsErrors, lane) {
  return `${proxyUrl || '__direct__'}${ignoreTlsErrors ? '|itls' : ''}${lane ? `|lane:${lane}` : ''}`;
}

async function getImpitInstance(proxyUrl, ignoreTlsErrors = false, lane = null) {
  const cacheKey = instanceKey(proxyUrl, ignoreTlsErrors, lane);
  if (impitCache.has(cacheKey)) return impitCache.get(cacheKey);

  const Impit = await getImpit();
  const instance = new Impit({
    browser: 'chrome',
    proxyUrl: proxyUrl || undefined,
    // Cert verification alters impit's ClientHello; some Cloudflare sites (EB Games) only pass with it off
    ignoreTlsErrors,
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
    ignoreTlsErrors = false,
    rawHeaders = false,
    // Some retailer APIs are POST-only (Costco's search gateway rejects GET). The Chrome TLS
    // fingerprint matters just as much there, so they go through this path rather than plain
    // node-fetch, which Costco's gateway simply hangs up on.
    method = 'GET',
    body = null,
    // Return {status, headers, body} instead of just the body — needed for conditional
    // requests, where a 304 carries no body and the status is the whole answer.
    withResponse = false,
    // Spreads parallel requests across separate connections, and therefore separate exit IPs.
    lane = null,
  } = opts;
  const cacheKey = instanceKey(proxyUrl, ignoreTlsErrors, lane);

  // The host asked us to back off and the window has not expired. Do not spend a request
  // finding that out again.
  const cooling = cooldownRemaining(url);
  if (cooling > 0) throw new Error(`Cooling down ${Math.round(cooling / 1000)}s after 429: ${url}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const impit = await getImpitInstance(proxyUrl, ignoreTlsErrors, lane);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      // rawHeaders skips the document-navigation defaults (XHR-style requests send their own set).
      const requestHeaders = rawHeaders ? { ...headers } : {
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
      };


      const response = await impit.fetch(url, {
        method,
        ...(body != null ? { body } : {}),
        headers: requestHeaders,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        const retryAfter = Math.max(parseInt(response.headers.get('retry-after') || '5') * 1000, 2000);
        // Record it before deciding whether to retry, so that even a no-retry caller
        // (maxRetries: 1) still stops the NEXT poll from walking into the same wall.
        setCooldown(url, retryAfter);
        if (attempt >= maxRetries) throw new Error(`Rate limited (429): ${url}`);
        logger.warn(`Stealth: rate limited on ${url}, waiting ${retryAfter}ms`);
        await sleep(retryAfter);
        continue;
      }

      if (response.status === 403 || response.status === 503) {
        logger.warn(`Stealth: blocked (${response.status}) on ${url}, attempt ${attempt}/${maxRetries}`);
        // Clear cached instance on block — next attempt gets a fresh connection
        impitCache.delete(cacheKey);
        if (attempt < maxRetries) {
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`Blocked after ${maxRetries} stealth attempts: ${response.status}`);
      }

      // Conditional requests: a 304 has no body, and the caller needs the status to know
      // nothing changed. Only returned when explicitly asked for, so existing callers that
      // expect a plain string are unaffected.
      if (withResponse) {
        const headers = {};
        if (response.headers?.forEach) response.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        const body = response.status === 304 ? '' : await response.text();
        return { status: response.status, headers, body };
      }

      if (json) {
        return await response.json();
      }
      return await response.text();
    } catch (err) {
      if (err.message?.includes('Blocked after')) throw err;

      // Clear cached instance on error
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
function _clearCache(proxyUrl, ignoreTlsErrors = false, lane = null) {
  impitCache.delete(instanceKey(proxyUrl, ignoreTlsErrors, lane));
}

function _resetCooldowns() { hostCooldowns.clear(); }

module.exports = { stealthGet, _clearCache, isRateLimited, cooldownRemaining, _resetCooldowns };
