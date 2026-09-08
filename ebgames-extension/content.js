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

// How long to wait before reloading when Cloudflare is mid-challenge. A real browser clears
// it on its own; reloading into it repeatedly is what makes the score worse.
const CHALLENGE_WAIT_MS = 20000;
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

function reloadIn(ms) {
  setTimeout(() => location.reload(), ms);
}

(async () => {
  const source = sourceKey();
  if (!source) return;

  if (isChallenge()) {
    reloadIn(CHALLENGE_WAIT_MS);
    return;
  }

  const { intervalSec = 25, enabled = true } = await chrome.storage.local.get(['intervalSec', 'enabled']);
  if (!enabled) return;

  const html = document.documentElement.outerHTML;
  let delay = Math.max(5, Number(intervalSec) || 25) * 1000;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'ebgames-listing', source, html });
    if (!res || !res.ok) delay = Math.max(delay, BACKOFF_MS);
  } catch {
    // Background worker asleep or reloading — not a reason to hammer the retailer.
    delay = Math.max(delay, BACKOFF_MS);
  }

  reloadIn(delay);
})();
