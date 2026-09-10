/**
 * TCG Monitor — Pokemon Center bridge, background worker.
 *
 * pokemoncenter.com is behind DataDome, which refuses every HTTP client and every proxy we have:
 * residential raw 403, residential+Patchright 403, Patchright direct hits an Imperva
 * interstitial, ScraperAPI 500s at every tier. The paid unlocker that does work manages ~1,459
 * checks a day — 21 DAYS for one pass over the store's 8,415 products — so no budget delivers
 * "track everything". A real browser does: measured 2026-09-11, four same-origin fetches in
 * parallel completed in 3.6s with no challenge, i.e. ~1.1 products/sec.
 *
 * This worker never touches pokemoncenter.com itself. It keeps one pinned tab on that origin,
 * relays work to and from the monitor, and does the cross-origin POST — which is allowed here,
 * and only here, because the monitor hosts are in host_permissions.
 */

const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  batchSize: 20,      // products requested per cycle
  concurrency: 2,     // simultaneous fetches. Measured safe at 4; 2 is the cautious start.
  cycleDelaySec: 5,   // pause between cycles
  enabled: false,     // OFF until configured — this one starts disabled on purpose
};

const TAB_URL = 'https://www.pokemoncenter.com/en-ca/?tcgbridge=1';
const TAB_MATCH = 'https://www.pokemoncenter.com/*tcgbridge=1*';

const log = [];
function record(entry) {
  log.unshift({ at: new Date().toISOString(), ...entry });
  log.length = Math.min(log.length, 30);
  chrome.storage.local.set({ pushLog: log });
}

async function cfg() {
  const c = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...c };
}

function apiBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

/** Ask the monitor which products to read next. A GET — it must not spend the write budget. */
async function fetchWork() {
  const c = await cfg();
  if (!c.baseUrl || !c.apiKey) {
    record({ error: 'not configured — open the extension options' });
    return { items: [] };
  }
  const url = `${apiBase(c.baseUrl)}/api/ingest/pokemoncenter/next?n=${encodeURIComponent(c.batchSize)}`;
  try {
    const r = await fetch(url, { headers: { 'x-api-key': c.apiKey } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      record({ error: `work HTTP ${r.status}`, ...body });
      return { items: [] };
    }
    return { items: Array.isArray(body.items) ? body.items : [] };
  } catch (err) {
    record({ error: `work: ${err.message}` });
    return { items: [] };
  }
}

/** Send what the browser read back to the monitor. */
async function pushResults(records) {
  const c = await cfg();
  if (!c.baseUrl || !c.apiKey) return { ok: false };
  const url = `${apiBase(c.baseUrl)}/api/ingest/pokemoncenter`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': c.apiKey },
      body: JSON.stringify({ records }),
    });
    const body = await r.json().catch(() => ({}));
    record({ pushed: records.length, status: r.status, ...body });
    if (r.ok) chrome.storage.local.set({ lastPushAt: Date.now() });
    return { ok: r.ok, ...body };
  } catch (err) {
    record({ error: `push: ${err.message}` });
    return { ok: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'pc-work') {
    (async () => {
      const c = await cfg();
      if (!c.enabled) return sendResponse({ items: [], enabled: false });
      const work = await fetchWork();
      sendResponse({ ...work, enabled: true, concurrency: c.concurrency, cycleDelaySec: c.cycleDelaySec });
    })();
    return true;
  }
  if (msg && msg.type === 'pc-results') {
    (async () => sendResponse(await pushResults(msg.records || [])))();
    return true;
  }
  if (msg && msg.type === 'pc-note') {
    record({ note: msg.text });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'pc-refresh') {
    (async () => { await ensureTab(true); sendResponse({ ok: true }); })();
    return true;
  }
  return false;
});

/**
 * Keep exactly one pinned bridge tab.
 *
 * The `tcgbridge=1` marker is what stops the content script running in the user's OWN Pokemon
 * Center tabs — they shop on this site, and a read loop firing inside a browsing session would
 * be both wrong and a good way to get that session scored.
 *
 * Every tab is resolved in one pass. MV3 tears the worker down between awaits, so a sequential
 * await loop can lose whatever it was about to do — that is a lesson from the EB Games bridge,
 * where it silently created one tab and dropped the other.
 */
async function ensureTab(force = false) {
  const c = await cfg();
  if (!c.enabled) return;
  const tabs = await chrome.tabs.query({ url: TAB_MATCH });
  if (tabs.length === 0) {
    await chrome.tabs.create({ url: TAB_URL, pinned: true, active: false });
    record({ note: 'bridge tab opened' });
    return;
  }
  if (force) {
    // A fresh GET, never location.reload(). Reload replays the original request, and on a
    // session-bearing site that is how a tab gets wedged on an expired-token page.
    await chrome.tabs.update(tabs[0].id, { url: TAB_URL });
  }
}

/**
 * Liveness is "did a push land recently", never "is the tab open".
 *
 * The EB Games bridge lost 8 minutes of pushes with no symptom at all when an extension reload
 * orphaned its content script: the tab was still there, fully loaded, with nothing driving it.
 * Tab presence is a liar; a timestamp is not.
 */
async function watchdog() {
  const c = await cfg();
  if (!c.enabled) return;
  const { lastPushAt = 0 } = await chrome.storage.local.get({ lastPushAt: 0 });
  const limit = Math.max(300000, (c.cycleDelaySec * 1000 + 120000) * 3);
  if (lastPushAt === 0 || Date.now() - lastPushAt > limit) {
    record({ note: `no push for ${Math.round((Date.now() - lastPushAt) / 1000)}s — restarting the tab` });
    await ensureTab(true);
  }
}

chrome.alarms.create('pc-ensure', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'pc-ensure') return;
  await ensureTab();
  await watchdog();
});

chrome.runtime.onInstalled.addListener(() => ensureTab(true));
chrome.runtime.onStartup.addListener(() => ensureTab(true));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k in DEFAULTS)) ensureTab(true);
});
