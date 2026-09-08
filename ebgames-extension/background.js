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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A fresh top-level GET for this tab. location.reload() repeats the ORIGINAL request, which
  // on Odoo means replaying a stale CSRF token and getting the same 400 forever.
  if (msg && msg.type === 'ebgames-next') {
    const target = TABS.find((t) => t.key === msg.source);
    if (target && sender.tab) chrome.tabs.update(sender.tab.id, { url: target.url }).catch(() => {});
    return undefined;
  }
  if (msg && msg.type === 'ebgames-note') {
    record({ source: msg.source, error: msg.note });
    return undefined;
  }
  if (msg && msg.type === 'ebgames-refresh') { refreshNow(); return undefined; }

  // Product image bytes, base64 over the message channel because runtime messages are JSON.
  if (msg && msg.type === 'ebgames-image') {
    (async () => {
      const cfg = await chrome.storage.local.get(DEFAULTS);
      if (!cfg.baseUrl || !cfg.apiKey) { sendResponse({ ok: false }); return; }
      try {
        const bin = Uint8Array.from(atob(msg.b64), (c) => c.charCodeAt(0));
        const url = `${cfg.baseUrl.replace(/\/+$/, '')}/api/ingest/ebgames/image?src=${encodeURIComponent(msg.src)}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-api-key': cfg.apiKey },
          body: bin,
        });
        // Recorded so the options page can show images landing. Without it there is no way to
        // tell a working thumbnail pipeline from a silent one until an alert happens to fire.
        await record(r.ok
          ? { source: 'image', note: `sent ${Math.round(bin.length / 1024)}kb` }
          : { source: 'image', error: `HTTP ${r.status}` });
        sendResponse({ ok: r.ok });
      } catch (err) {
        await record({ source: 'image', error: err.message });
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
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
      if (r.ok) await chrome.storage.local.set({ lastPushAt: Date.now() });
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
 *
 * Every tab is resolved in ONE pass rather than a sequential await loop. MV3 tears the service
 * worker down between awaits, so a loop that created the first tab and then yielded lost the
 * second one entirely — which is exactly what happened on first install: one pinned tab, and
 * the other only appearing when the next alarm fired a minute later.
 */
async function ensureTabs() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  if (!enabled) return;
  const queries = await Promise.all(
    TABS.map((t) => chrome.tabs.query({ url: `${t.url.split('?')[0]}*` }).catch(() => []))
  );
  const missing = TABS.filter((_, i) => queries[i].length === 0);
  if (missing.length === 0) return;
  await Promise.all(
    missing.map((t) => chrome.tabs.create({ url: t.url, pinned: true, active: false }).catch(() => null))
  );
  await record({ source: missing.map((t) => t.key).join(', '), note: 'opened tab' });
}

/**
 * Send the category tabs to a fresh URL now, instead of waiting out whatever backoff they are
 * sitting in. Navigation, not reload — a tab wedged on Odoo's stale-session 400 would reload
 * straight back into it.
 */
async function refreshNow() {
  await ensureTabs();
  const found = await Promise.all(
    TABS.map((t) => chrome.tabs.query({ url: `${t.url.split('?')[0]}*` })
      .then((tabs) => tabs.map((tab) => ({ tab, url: t.url })))
      .catch(() => []))
  );
  await Promise.all(found.flat().map(({ tab, url }) => chrome.tabs.update(tab.id, { url }).catch(() => null)));
}

// Clicking the toolbar icon opens the options. There is no popup, so without this the icon
// looks broken — and the options page is the only place the push log is visible.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

/**
 * Restart the loop if it has gone quiet.
 *
 * The refresh cycle lives in the page: the content script posts, then schedules the next
 * navigation. Reloading or updating the extension kills the content scripts in already-open
 * tabs and takes that pending timer with them, leaving the tabs fully loaded with nothing
 * driving them — and ensureTabs() sees a tab present and does nothing. That is exactly how
 * pushes stopped dead for eight minutes on 2026-09-08 the moment the extension was reloaded,
 * with no symptom on this side at all. Chrome updates and extension auto-updates do the same.
 *
 * So liveness is judged on the only thing that matters: when a push last succeeded.
 */
async function watchdog() {
  const { enabled = true, intervalSec = 25, lastPushAt = 0 } = await chrome.storage.local.get(
    ['enabled', 'intervalSec', 'lastPushAt']
  );
  if (!enabled) return;
  const silentFor = Date.now() - lastPushAt;
  const limit = Math.max(90000, Number(intervalSec) * 3000);
  if (lastPushAt === 0 || silentFor > limit) {
    await record({ source: 'watchdog', note: `no push for ${Math.round(silentFor / 1000)}s — restarting tabs` });
    await refreshNow();
  }
}

// onInstalled fires on reload and on update too, which is precisely when the open tabs are
// left with dead content scripts — so re-navigate them rather than only filling gaps.
chrome.runtime.onInstalled.addListener(refreshNow);
chrome.runtime.onStartup.addListener(refreshNow);
chrome.alarms.create('ensure-tabs', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'ensure-tabs') return;
  ensureTabs().then(watchdog);
});

/**
 * Saving the options must take effect at once. The tabs open before there is any config to
 * use, so their first push is refused and the content script backs off for two minutes —
 * without this, entering a correct key looked like nothing happening at all.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (['baseUrl', 'apiKey', 'intervalSec', 'enabled'].some((k) => k in changes)) refreshNow();
});
