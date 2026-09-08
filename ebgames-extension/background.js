/**
 * Ships what the content script read to the monitor, and keeps the category tabs alive.
 *
 * The POST goes out from the extension's own origin with host_permissions, so it is not
 * subject to the page's CORS. Only the ebgames.ca side has to look like real browsing.
 */

const DEFAULTS = { baseUrl: '', apiKey: '', intervalSec: 25, enabled: true };

const TABS = [
  { key: 'pokemon', url: 'https://www.ebgames.ca/shop/category/trading-cards-pokemon-204?order=write_date+desc' },
  { key: 'onepiece', url: 'https://www.ebgames.ca/shop/category/trading-cards-one-piece-208?order=write_date+desc' },
];

async function record(entry) {
  const { pushLog = [] } = await chrome.storage.local.get('pushLog');
  pushLog.unshift({ at: Date.now(), ...entry });
  await chrome.storage.local.set({ pushLog: pushLog.slice(0, 20) });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ebgames-listing') return undefined;

  (async () => {
    const cfg = await chrome.storage.local.get(DEFAULTS);
    if (!cfg.baseUrl || !cfg.apiKey) {
      await record({ source: msg.source, error: 'not configured — open the extension options' });
      sendResponse({ ok: false, error: 'not configured' });
      return;
    }
    const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/ingest/ebgames?source=${encodeURIComponent(msg.source)}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/html', 'x-api-key': cfg.apiKey },
        body: msg.html,
      });
      const body = await r.json().catch(() => ({}));
      await record({ source: msg.source, status: r.status, ...body });
      sendResponse({ ok: r.ok, ...body });
    } catch (err) {
      await record({ source: msg.source, error: err.message });
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // response is async
});

/**
 * A closed or crashed tab is a silent outage — the monitor would just stop hearing from us.
 * Re-open anything missing once a minute.
 */
async function ensureTabs() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (!enabled) return;
  for (const t of TABS) {
    const base = t.url.split('?')[0];
    const found = await chrome.tabs.query({ url: `${base}*` });
    if (found.length === 0) {
      await chrome.tabs.create({ url: t.url, pinned: true, active: false });
    }
  }
}

chrome.runtime.onInstalled.addListener(ensureTabs);
chrome.runtime.onStartup.addListener(ensureTabs);
chrome.alarms.create('ensure-tabs', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'ensure-tabs') ensureTabs(); });
