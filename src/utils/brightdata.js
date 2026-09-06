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

// Retry policy, by cause rather than by clock.
//
// The first version retried only failures faster than 40s, on the assumption that an empty
// body comes back quickly. Instrumenting production disproved that: every failure was an
// empty body, and they took 59-99s. So the rule skipped precisely the cases a retry fixes.
//
// An empty body is Bright Data giving up internally and is worth another attempt. Our own
// timeout is not — repeating it produces the same timeout and doubles the wait for nothing.
// This is only affordable because these checks now run off the poll path, so a slow retry
// delays nothing, and because Bright Data bills successful responses only.
const RETRYABLE = new Set(['empty_body', 'short_body', 'network_error']);

// 2 of 5 first attempts came back HTTP 200 with a ZERO-length body — not a block, just
// nothing. Both succeeded on the next try, so one retry is the difference between a 60% and
// a 100% success rate here.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

const usage = { calls: 0, callSuccesses: 0, requests: 0, successes: 0, empties: 0, failures: 0, msTotal: 0 };

// WHY a call failed, not just that it did. Production sat at ~50% while the identical key,
// zone and URLs returned 6/6 from a developer machine, and without a reason breakdown there
// was nothing to act on but guesses.
const failReasons = Object.create(null);
const recentFailures = [];   // last few, with status and duration, for the admin API
function noteFailure(reason, detail) {
  failReasons[reason] = (failReasons[reason] || 0) + 1;
  recentFailures.unshift({ reason, ...detail, at: new Date().toISOString() });
  if (recentFailures.length > 8) recentFailures.pop();
}

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
  let lastReason = null;
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
      const ms = Date.now() - started;
      if (!body || body.length === 0) {
        usage.empties++;
        lastReason = 'empty_body';
        noteFailure('empty_body', { status: res.status, ms, label });
      } else if (!res.ok) {
        usage.failures++;
        // The body of a non-200 is Bright Data telling us why; keep a slice of it.
        lastReason = 'http_' + res.status;
        noteFailure(lastReason, { status: res.status, ms, label, body: body.slice(0, 160) });
      } else {
        usage.failures++;
        lastReason = 'short_body';
        noteFailure('short_body', { status: res.status, ms, label, bytes: body.length });
      }
      logger.debug(`Bright Data: ${label} attempt ${attempt}/${attempts} — HTTP ${res.status}, ${body.length}b in ${ms}ms`);
    } catch (err) {
      const ms = Date.now() - started;
      usage.msTotal += ms;
      usage.failures++;
      // A TimeoutError here is OUR deadline, not Bright Data refusing — worth separating,
      // because the fix for one is a longer ceiling and for the other is a different vendor.
      const reason = /timeout|aborted/i.test(err.message || '') ? 'our_timeout' : 'network_error';
      lastReason = reason;
      noteFailure(reason, { ms, label, message: String(err.message).slice(0, 120) });
      logger.debug(`Bright Data: ${label} attempt ${attempt}/${attempts} failed after ${ms}ms: ${err.message}`);
    }
    if (attempt < attempts && RETRYABLE.has(lastReason)) {
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
    failReasons,
    recentFailures,
  };
}

module.exports = { isConfigured, unlock, getUsage };
