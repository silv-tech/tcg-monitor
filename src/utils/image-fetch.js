/**
 * Fetch a product image's raw bytes so we can attach it to a Discord alert directly.
 *
 * Why this exists: a Discord embed thumbnail is a URL that DISCORD'S servers fetch. That works
 * for Amazon and Walmart, whose image CDNs serve anyone. It does NOT work for EB Games: its
 * images sit behind the same Cloudflare that fingerprint-blocks every datacenter fetcher, so
 * Discord's fetch gets a 403 and the alert shows no picture. The only way to put an EB Games
 * picture in an alert is to fetch the bytes ourselves and upload them as a Discord attachment.
 *
 * HOW the bytes are fetched — and why this is the ONLY route that works (verified 2026-09-08):
 *
 *   EB Games' Cloudflare 403s every datacenter and residential-PROXY IP we have, regardless of
 *   TLS fingerprint (Immaculate, Lavish, ISP, direct — all 403). ScraperAPI reaches the site
 *   (it serves the listings) but UTF-8-corrupts image bytes server-side — its response is
 *   `image/jpeg; charset=utf-8` with every high byte replaced by U+FFFD, irrecoverable, and its
 *   binary_target mode rejects the file type outright. So ScraperAPI is useless for images and
 *   we deliberately do NOT spend a credit on it here.
 *
 *   What DOES work is the Bright Data "chrome API" — their cloud Chrome on a residential IP:
 *     - the residential IP passes Cloudflare, and
 *     - CDP returns the response body base64-encoded, so the bytes never touch a text decode.
 *   Proven end to end: a residential-Chrome CDP fetch returns byte-exact image data.
 *
 *   It is gated behind BRIGHTDATA_IMAGE_FETCH because Bright Data currently blocks ebgames.ca
 *   ("classified as Games") until the account is KYC-verified. While blocked, every attempt
 *   costs a browser session only to fail, so we don't even try until the flag is set. The day
 *   verification clears, set BRIGHTDATA_IMAGE_FETCH=true and pictures appear — no code change.
 *
 * Bytes are cached in Redis so a product that restocks repeatedly is fetched once. Deliberately
 * narrow: only hosts we KNOW block Discord's fetcher are routed here (see BLOCKED_IMAGE_HOSTS in
 * the delivery layer). Everything else keeps using a free remote thumbnail.
 */

const crypto = require('crypto');
const logger = require('../monitoring/logger');
const state = require('../core/state');

// A product thumbnail is tens to low-hundreds of KB. Anything outside this band is not the
// image we asked for (a challenge page, an error blob) and must not be attached.
const MIN_IMAGE_BYTES = 512;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// 30 days: a product's image is effectively immutable, and this is only ever a cache of public
// bytes. Long TTL means a weekly restock of the same SKU costs one credit, not one per alert.
const CACHE_TTL_SEC = 30 * 24 * 3600;

/** Sniff the leading bytes so we never attach an HTML challenge page as if it were a picture. */
function looksLikeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_IMAGE_BYTES || buf.length > MAX_IMAGE_BYTES) return false;
  // JPEG FF D8 FF, PNG 89 50 4E 47, GIF 47 49 46, WEBP "RIFF"..."WEBP", BMP 42 4D
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true;
  return false;
}

function cacheKey(url) {
  return `tcg:imgcache:${crypto.createHash('sha1').update(url).digest('hex')}`;
}

async function readCache(url) {
  try {
    const redis = state.getRedis();
    if (!redis) return null;
    // Bounded: delivering the alert must never stall on Redis. A miss just means we fetch.
    const b64 = await Promise.race([
      redis.get(cacheKey(url)),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    return looksLikeImage(buf) ? buf : null;
  } catch {
    return null;
  }
}

async function writeCache(url, buf) {
  try {
    const redis = state.getRedis();
    if (!redis) return;
    await redis.set(cacheKey(url), buf.toString('base64'), 'EX', CACHE_TTL_SEC);
  } catch {
    // Non-critical: a cache write failure just means the next alert re-fetches.
  }
}

/**
 * Fetch image bytes for a URL Discord itself cannot reach.
 *
 * @param {string} url absolute image URL
 * @param {{retailerId?:string, timeoutMs?:number}} opts
 * @returns {Promise<Buffer|null>} the image bytes, or null if unavailable (caller falls back
 *   to a remote thumbnail / no image — never throws, never blocks the alert indefinitely)
 */
/**
 * Fetch image bytes via the Bright Data "chrome API" — a real Chrome on a residential IP whose
 * CDP hands back the response body base64-clean. This is the only route that survives both EB
 * Games' Cloudflare (residential IP) and the byte corruption (CDP, not a text decode).
 *
 * Heavy dependency (patchright) is required lazily so this module stays cheap to load and does
 * not drag a browser into unit tests. Bounded and never-throwing: any failure — no WS, no
 * patchright, the "classified as Games" policy block, a timeout — returns null, and the alert
 * sends without a picture exactly as before.
 *
 * @returns {Promise<Buffer|null>}
 */
async function fetchViaBrowser(url, timeoutMs) {
  const ws = process.env.BRIGHTDATA_BROWSER_WS;
  if (!ws) return null;

  let chromium;
  try { ({ chromium } = require('patchright')); }
  catch { return null; }

  let browser;
  try {
    browser = await chromium.connectOverCDP(ws, { timeout: timeoutMs });
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();
    try {
      // 'commit' resolves as soon as the response headers arrive — we want the resource itself,
      // not a fully settled render, and the body is available regardless.
      const resp = await page.goto(url, { timeout: timeoutMs, waitUntil: 'commit' });
      if (!resp) return null;
      const buf = await resp.body();
      if (!looksLikeImage(buf)) {
        logger.warn(`image-fetch(browser): ${Buffer.isBuffer(buf) ? buf.length + 'B' : typeof buf} is not an image — ${url.slice(0, 80)}`);
        return null;
      }
      return buf;
    } finally {
      await page.close().catch(() => {});
    }
  } catch (err) {
    // The policy block ("classified as Games") lands here until the account is KYC-verified.
    logger.warn(`image-fetch(browser): ${String(err.message || err).slice(0, 160)}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchImageBytes(url, opts = {}) {
  const { timeoutMs = 20000 } = opts;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const cached = await readCache(url);
  if (cached) return cached;

  // The chrome API is the only route that returns intact bytes for our blocked hosts, and it is
  // billed per browser session, so we only attempt it when explicitly enabled (post-KYC). We do
  // NOT fall back to ScraperAPI: it corrupts image binary for exactly these hosts (verified), so
  // an attempt there would spend a credit to produce a blob looksLikeImage always rejects.
  if (process.env.BRIGHTDATA_IMAGE_FETCH === 'true') {
    const buf = await module.exports.fetchViaBrowser(url, timeoutMs);
    if (buf) {
      await writeCache(url, buf);
      return buf;
    }
  }
  return null;
}

module.exports = { fetchImageBytes, fetchViaBrowser, looksLikeImage, cacheKey };
