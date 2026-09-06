const logger = require('../monitoring/logger');

/**
 * Bright Data Web Unlocker.
 *
 * Added for Pokemon Center, which stacks DataDome AND Imperva Incapsula. Measured on
 * 2026-09-06, every other path we own fails on its product pages:
 *   - residential raw HTTP           403
 *   - residential + Patchright       403
 *   - direct + Patchright            200, but an Imperva interstitial
 *   - ScraperAPI std/premium/ultra   500 after ~55s, with and without JS rendering
 *   - ScraperAPI Async (24h retries) 5.8 minutes, then a DataDome block page
 * Bright Data returned real stock fields on 5/5 with one retry, median 26s.
 *
 * Billing is success-only, so a blocked attempt costs nothing — the same shape as
 * ScraperAPI's 500s. That is what makes the retry below safe.
 */

const API_URL = 'https://api.brightdata.com/request';
const API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const ZONE = process.env.BRIGHTDATA_ZONE || '';

// Measured worst case was 44s; the ceiling is generous because a slow success is still far
// cheaper than a retry, and the caller is a background rotation rather than a drop race.
// Sized against measured behaviour, not a guess. Real rotation URLs fetched from a fast
// connection ranged 16.4s to 58.7s — a long tail, not a stable latency — and production's
// path to Bright Data is slower still. 75s clipped that tail.
const TIMEOUT_MS = Number(process.env.BRIGHTDATA_TIMEOUT_MS) || 110000;

// Retrying a TIMEOUT just spends the whole budget twice to fail twice. Retrying an EMPTY is
// worth it: those come back in seconds and succeeded immediately on the next try in every
// observed case. So a retry only happens when the first attempt failed FAST, which is the
// signature of an empty rather than a slow block.
const RETRY_ONLY_IF_FASTER_THAN_MS = 40000;

// 2 of 5 first attempts came back HTTP 200 with a ZERO-length body — not a block, just
// nothing. Both succeeded on the next try, so one retry is the difference between a 60% and
// a 100% success rate here.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

const usage = { calls: 0, callSuccesses: 0, requests: 0, successes: 0, empties: 0, failures: 0, msTotal: 0 };

function isConfigured() {
  return Boolean(API_KEY && ZONE);
}

/**
 * Fetch a URL through Web Unlocker.
 * @returns {Promise<string|null>} the page HTML, or null if it could not be retrieved
 */
async function unlock(url, opts = {}) {
  if (!isConfigured()) return null;
  const { timeoutMs = TIMEOUT_MS, attempts = MAX_ATTEMPTS, label = 'brightdata' } = opts;

  usage.calls++;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    const attemptStarted = started;
    usage.requests++;
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ zone: ZONE, url, format: 'raw' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text();
      usage.msTotal += Date.now() - started;

      if (res.ok && body && body.length > 1000) {
        usage.successes++;
        usage.callSuccesses++;
        return body;
      }
      // An empty 200 is the known transient. Anything else is a real failure, but both are
      // worth one more try since neither is billed.
      if (!body || body.length === 0) usage.empties++; else usage.failures++;
      logger.debug(`Bright Data: ${label} attempt ${attempt}/${attempts} — HTTP ${res.status}, ${body.length}b`);
    } catch (err) {
      usage.msTotal += Date.now() - started;
      usage.failures++;
      logger.debug(`Bright Data: ${label} attempt ${attempt}/${attempts} failed: ${err.message}`);
    }
    // Only retry a FAST failure. A slow one is a timeout, and repeating it would burn the
    // caller's entire budget to fail a second time in exactly the same way.
    const elapsed = Date.now() - attemptStarted;
    if (attempt < attempts && elapsed < RETRY_ONLY_IF_FASTER_THAN_MS) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    break;
  }
  return null;
}

/** For the admin API, so spend and success rate are visible rather than assumed. */
function getUsage() {
  return {
    configured: isConfigured(),
    zone: ZONE || null,
    ...usage,
    // Per CALL is the number that matters — a call that retries once and then succeeds is a
    // success, not a 50% rate. Reporting only per-attempt made the integration look far
    // worse than it was.
    callSuccessRate: usage.calls ? Number((usage.callSuccesses / usage.calls).toFixed(3)) : null,
    attemptSuccessRate: usage.requests ? Number((usage.successes / usage.requests).toFixed(3)) : null,
    avgMs: usage.successes ? Math.round(usage.msTotal / usage.requests) : null,
    // Bright Data bills successful responses only, so this is the real spend.
    billableRequests: usage.successes,
  };
}

module.exports = { isConfigured, unlock, getUsage };
