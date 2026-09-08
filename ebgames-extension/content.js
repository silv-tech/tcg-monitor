/**
 * Runs inside a real EB Games category tab.
 *
 * The whole point of this extension is that the request to ebgames.ca is a genuine navigation
 * in a genuine profile. Cloudflare runs a managed JS challenge here and scores the CLIENT:
 * curl, node fetch, headless Chromium and headed Chromium all get 403 from the very same
 * address that serves this page normally. So the page is never fetched — it is browsed, and
 * this script only reads what the browser already rendered and hands it to the background
 * worker. Do not "simplify" this into a fetch(); that is the thing that does not work.
 */

const SOURCES = {
  'trading-cards-pokemon-204': 'pokemon',
  'trading-cards-one-piece-208': 'onepiece',
};

// How long to wait before re-navigating when Cloudflare is mid-challenge. A real browser
// clears it on its own; reloading into it repeatedly is what makes the score worse.
const CHALLENGE_WAIT_MS = 20000;
// EB Games runs Odoo, which answers a stale session with "400: Bad Request — Session expired
// (invalid CSRF token)". Recover quickly, since a fresh navigation is all it takes.
const SESSION_ERROR_WAIT_MS = 8000;
// Applied when the monitor rejected the push, so a broken parser or a bad key does not turn
// into a tight reload loop against the retailer.
const BACKOFF_MS = 120000;

function sourceKey() {
  for (const [fragment, key] of Object.entries(SOURCES)) {
    if (location.pathname.includes(fragment)) return key;
  }
  return null;
}

function isChallenge() {
  if (/just a moment|attention required/i.test(document.title)) return true;
  return !!document.querySelector('#challenge-running, #challenge-form, [id^="cf-chl"]');
}

/**
 * Odoo's stale-session page. It is served AT the category URL with a 400, so it looks like a
 * normal load to everything except the body — and location.reload() re-issues the request that
 * produced it, which is how a tab gets wedged here permanently.
 */
function isSessionError() {
  const text = document.body ? document.body.innerText.slice(0, 2000) : '';
  return /invalid CSRF token|Session expired|400: Bad Request/i.test(text);
}

/**
 * Always a FRESH top-level GET, never a reload. The background worker drives it, because
 * location.reload() repeats the original request — stale token and all.
 */
function navigateIn(ms, source) {
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'ebgames-next', source }).catch(() => {
      // Worker unreachable; a plain assignment is still better than a reload.
      location.href = location.pathname + location.search;
    });
  }, ms);
}

// At most this many images per page load. The monitor's API allows 30 writes a minute per IP
// and the listings themselves need two of those per cycle: at four images x two tabs the
// backfill alone reached ~24/min, close enough to trip the limiter and take the listings down
// with it. Two keeps a cycle at ~14/min and still backfills the catalogue in a few minutes.
const IMAGES_PER_CYCLE = 2;
// Re-send an image occasionally: the monitor's cache expires, and a listing's picture can be
// replaced. Well under the server's 30-day cache so a live product never loses its thumbnail.
const IMAGE_RESEND_MS = 7 * 24 * 60 * 60 * 1000;

async function uploadNewImages() {
  const nodes = [...document.querySelectorAll('img[src^="/web/image/product.product/"]')];
  if (nodes.length === 0) return;

  const { imagesSent = {} } = await chrome.storage.local.get('imagesSent');
  const now = Date.now();
  const todo = [];
  for (const img of nodes) {
    const src = img.getAttribute('src');
    if (!src) continue;
    if (imagesSent[src] && now - imagesSent[src] < IMAGE_RESEND_MS) continue;
    if (!todo.includes(src)) todo.push(src);
    if (todo.length >= IMAGES_PER_CYCLE) break;
  }
  if (todo.length === 0) return;

  for (const src of todo) {
    try {
      // Same-origin fetch from a page that has already cleared Cloudflare, so this is the one
      // context in which these bytes are obtainable for free.
      const blob = await (await fetch(src)).blob();
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const res = await chrome.runtime.sendMessage({ type: 'ebgames-image', src, b64 });
      if (res && res.ok) imagesSent[src] = now;
    } catch {
      // A missing picture costs one field on an alert; never let it disturb the listing loop.
    }
  }

  // Keep the record from growing without bound as the catalogue turns over.
  const entries = Object.entries(imagesSent).sort((a, b) => b[1] - a[1]).slice(0, 500);
  await chrome.storage.local.set({ imagesSent: Object.fromEntries(entries) });
}

(async () => {
  const source = sourceKey();
  if (!source) return;

  const { intervalSec = 25, enabled = true } = await chrome.storage.local.get(['intervalSec', 'enabled']);
  if (!enabled) return;

  if (isChallenge()) { navigateIn(CHALLENGE_WAIT_MS, source); return; }
  if (isSessionError()) {
    chrome.runtime.sendMessage({ type: 'ebgames-note', source, note: 'Odoo session expired — re-navigating' }).catch(() => {});
    navigateIn(SESSION_ERROR_WAIT_MS, source);
    return;
  }

  const html = document.documentElement.outerHTML;
  let delay = Math.max(5, Number(intervalSec) || 25) * 1000;

  // Hand over any product images the monitor has not been given yet. Discord cannot fetch
  // ebgames.ca images — the same Cloudflare that refuses every datacenter client refuses
  // Discord's fetcher too — so the bytes have to come from a browser that can load them.
  // This one already has the page open, so they are free here.
  //
  // Bounded per cycle, and each image is sent once: the point of this bridge is a SMALL
  // footprint, and uploading eighteen pictures every 25 seconds would undo that.
  uploadNewImages().catch(() => {});

  try {
    const res = await chrome.runtime.sendMessage({ type: 'ebgames-listing', source, html });
    if (!res || !res.ok) delay = Math.max(delay, BACKOFF_MS);
  } catch {
    // Background worker asleep or reloading — not a reason to hammer the retailer.
    delay = Math.max(delay, BACKOFF_MS);
  }

  navigateIn(delay, source);
})();
