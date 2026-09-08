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

  try {
    const res = await chrome.runtime.sendMessage({ type: 'ebgames-listing', source, html });
    if (!res || !res.ok) delay = Math.max(delay, BACKOFF_MS);
  } catch {
    // Background worker asleep or reloading — not a reason to hammer the retailer.
    delay = Math.max(delay, BACKOFF_MS);
  }

  navigateIn(delay, source);
})();
