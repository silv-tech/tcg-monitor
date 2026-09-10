/**
 * TCG Monitor — Pokemon Center bridge, page side.
 *
 * Runs inside a pokemoncenter.com tab and reads product pages with same-origin fetches. That is
 * the whole trick: the tab has already cleared DataDome, so a fetch from it returns the real
 * server HTML, while the same request from any HTTP client or proxy is refused.
 *
 * Measured 2026-09-11 in a real Chrome:
 *   fetch(product, { credentials: 'include' })  -> 451KB, real ld+json, no challenge
 *   fetch(product, { credentials: 'omit'    })  -> 859 bytes, DataDome challenge
 *   four in parallel                            -> 3.6s wall, ~1.1 products/sec
 *
 * Only the ld+json block is sent onward: a product page is ~440KB and its ld+json ~1.3KB, so a
 * full 8,415-product pass is ~11MB instead of ~3.7GB, and the monitor keeps parsing with the
 * same parser its paid path used.
 */

// Only ever run in the dedicated bridge tab. The user shops on this site; a read loop firing
// inside their own browsing session would be wrong, and a good way to get that session scored.
const IS_BRIDGE_TAB = new URLSearchParams(location.search).get('tcgbridge') === '1';

// A challenge means STOP, not slow down. Getting this residential address blocked would cost the
// user a store they buy from, and the same vendor has already blocked their home network and
// their phone on another site. Half an hour of silence is cheap by comparison.
const CHALLENGE_BACKOFF_MS = 30 * 60 * 1000;
const ERROR_BACKOFF_MS = 2 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
  catch { resolve(null); }
});

/**
 * Pull the Product ld+json out of a fetched page.
 *
 * Returns the RAW block text so the monitor does the parsing — one parser, server-side, rather
 * than a second copy here that would drift out of step with the site.
 */
function extractProductLd(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    const raw = m[1].trim();
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    if (json['@type'] !== 'Product') continue;
    const offers = Array.isArray(json.offers) ? json.offers[0] : json.offers;
    // The category listing carries Product blocks with an empty sku and a constant OutOfStock;
    // a real product page carries availability. Require it, so a wrong page cannot look right.
    if (!offers || !offers.availability) continue;
    return raw;
  }
  return null;
}

/**
 * Is this a bot wall rather than a page?
 *
 * Deliberately NOT keyed on the word "datadome" or on captcha-delivery alone: those scripts load
 * on perfectly good Pokemon Center pages, and the monitor's own adapter carries a note about
 * exactly that mistake throwing away every real page. The reliable signals are a body far too
 * small to be a product page, or a redirect away from the product URL.
 */
function looksBlocked(html, res, wantedUrl) {
  if (!html || html.length < 5000) return true;
  if (res && res.redirected && !res.url.includes('/product/')) return true;
  return false;
}

async function readOne(item) {
  const res = await fetch(item.url, { credentials: 'include', redirect: 'follow' });
  const html = await res.text();
  if (res.status === 429) return { blocked: true, why: 'HTTP 429' };
  if (looksBlocked(html, res, item.url)) return { blocked: true, why: `short body (${html.length}b)` };
  const ld = extractProductLd(html);
  if (!ld) return { miss: true };
  return { record: { sku: item.sku, ld } };
}

/** Run the batch with a small pool, so a cycle is not a burst. */
async function readBatch(items, concurrency) {
  const out = [];
  let blocked = null;
  let misses = 0;
  let next = 0;
  async function worker() {
    while (next < items.length && !blocked) {
      const item = items[next++];
      try {
        const r = await readOne(item);
        if (r.blocked) { blocked = r.why; break; }
        if (r.miss) misses++;
        else out.push(r.record);
      } catch (err) {
        misses++;
      }
      await sleep(200 + Math.floor(Math.random() * 400));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(6, concurrency)) }, worker));
  return { records: out, blocked, misses };
}

async function cycle() {
  if (!IS_BRIDGE_TAB) return;

  const work = await send({ type: 'pc-work' });
  if (!work) { await sleep(ERROR_BACKOFF_MS); return cycle(); }          // worker asleep or reloading
  if (!work.enabled) { await sleep(60000); return cycle(); }
  if (!work.items || work.items.length === 0) { await sleep(60000); return cycle(); }

  const { records, blocked, misses } = await readBatch(work.items, work.concurrency || 2);

  if (records.length > 0) await send({ type: 'pc-results', records });

  if (blocked) {
    await send({ type: 'pc-note', text: `blocked (${blocked}) — pausing ${CHALLENGE_BACKOFF_MS / 60000}min` });
    await sleep(CHALLENGE_BACKOFF_MS);
    return cycle();
  }
  if (misses > 0 && records.length === 0) {
    // Nothing parsed at all. Either the markup moved or something is wrong with this session;
    // either way, backing off beats hammering.
    await send({ type: 'pc-note', text: `${misses} pages parsed nothing — backing off` });
    await sleep(ERROR_BACKOFF_MS);
    return cycle();
  }

  await sleep(Math.max(1, work.cycleDelaySec || 5) * 1000);
  return cycle();
}

if (IS_BRIDGE_TAB) cycle();

// Exported for tests only — the sandbox has no window, so nothing runs above.
if (typeof module !== 'undefined') module.exports = { extractProductLd, looksBlocked };
