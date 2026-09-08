/**
 * Fetch a product image's raw bytes so we can attach it to a Discord alert directly.
 *
 * Why this exists: a Discord embed thumbnail is a URL that DISCORD'S servers fetch. That works
 * for Amazon and Walmart, whose image CDNs serve anyone. It does NOT work for EB Games: its
 * images sit behind the same Cloudflare that fingerprint-blocks every datacenter fetcher, so
 * Discord's fetch gets a 403 and the alert shows no picture. The only way to put an EB Games
 * picture in an alert is to fetch the bytes ourselves and upload them as a Discord attachment.
 *
 * We already pay for ScraperAPI and it already serves EB Games' pages from an IP Cloudflare
 * accepts, so the image rides the same channel at 1 standard credit — no new proxy, no image
 * host. Bytes are cached in Redis so a product that restocks repeatedly is fetched once.
 *
 * Deliberately narrow: only hosts we KNOW block Discord's fetcher are routed here (see
 * BLOCKED_IMAGE_HOSTS in the delivery layer). Everything else keeps using a remote thumbnail,
 * which costs nothing.
 */

const crypto = require('crypto');
const logger = require('../monitoring/logger');
const scraperApi = require('./scraper-api');
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
async function fetchImageBytes(url, opts = {}) {
  const { retailerId = 'image', timeoutMs = 12000 } = opts;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const cached = await readCache(url);
  if (cached) return cached;

  if (!scraperApi.isConfigured()) return null;

  try {
    const buf = await scraperApi.scraperFetch(url, {
      binary: true,
      render: false,
      premium: false,
      ultraPremium: false,
      country: 'us',
      timeoutMs,
      retailerId,
      // Image fetches are per-alert and low-volume; they must not be swallowed by the 5-minute
      // page-fetch floor that governs listing crawls for the same retailer.
      minIntervalMs: 0,
    });
    if (!buf) return null; // rate-limited or budget-paused inside scraperFetch
    if (!looksLikeImage(buf)) {
      logger.warn(`image-fetch: ${retailerId} returned ${Buffer.isBuffer(buf) ? buf.length + 'B' : typeof buf} that is not an image — ${url.slice(0, 80)}`);
      return null;
    }
    await writeCache(url, buf);
    return buf;
  } catch (err) {
    logger.warn(`image-fetch: could not fetch ${url.slice(0, 80)}: ${err.message}`);
    return null;
  }
}

module.exports = { fetchImageBytes, looksLikeImage, cacheKey };
