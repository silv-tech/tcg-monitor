/**
 * TCG Monitor — Amazon bridge, background worker.
 *
 * Why this exists. Amazon stock currently costs money: the priority lane buys
 * `structured/amazon/offers` from ScraperAPI, ~4,800 credits/day at the safe 180s cadence, and
 * the 60s cadence the client wants is gated on upgrading that plan. Meanwhile the free paths are
 * partial — batched ASIN search reaches ~96.5% of tracked ASINs and can NEVER see a
 * suppressed-OOS one, which is precisely the state a hot product sits in just before it restocks.
 *
 * A real Canadian browser has neither problem. It reads the buy box directly, for free, from the
 * marketplace the client actually buys in — which also removes the `tld=ca` trap outright, since
 * there is no marketplace to get wrong.
 *
 * This worker never touches amazon.ca itself. It keeps one pinned tab on that origin, relays
 * work to and from the monitor, and does the cross-origin POST — allowed here, and only here,
 * because the monitor hosts are in host_permissions.
 */

const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  batchSize: 12,      // ASINs requested per cycle
  concurrency: 1,     // simultaneous fetches. Start at one. See the README.
  gapMs: 900,         // base pause between reads inside a batch (jittered up to 2x in page.js)
  cycleDelaySec: 20,  // pause between cycles
  enabled: false,     // OFF until configured — deliberately
};

// The bridge tab sits on a page that is cheap for Amazon to serve and is not a product page, so
// it is not itself a signal about anything we track. The marker is what keeps this whole
// extension inert in the client's real shopping tabs.
const TAB_URL = 'https://www.amazon.ca/?tcgbridge=1';
const TAB_MATCH = 'https://www.amazon.ca/*tcgbridge=1*';

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

const apiBase = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

/** Ask the monitor which ASINs to read next. A GET — it must not spend the write budget. */
async function fetchWork() {
  const c = await cfg();
  if (!c.baseUrl || !c.apiKey) {
    record({ error: 'not configured — open the extension options' });
    return { items: [] };
  }
  const url = `${apiBase(c.baseUrl)}/api/ingest/amazon/next?n=${encodeURIComponent(c.batchSize)}`;
  try {
    const r = await fetch(url, { headers: { 'x-api-key': c.apiKey } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { record({ error: `work: HTTP ${r.status} ${body.error || ''}`.trim() }); return { items: [] }; }
    return { items: body.items || [] };
  } catch (err) {
    record({ error: `work: ${err.message}` });
    return { items: [] };
  }
}

/** Send what the browser read back to the monitor. */
async function pushResults(records) {
  const c = await cfg();
  if (!c.baseUrl || !c.apiKey) return { ok: false };
  const url = `${apiBase(c.baseUrl)}/api/ingest/amazon`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.apiKey,
        // Chrome runs an unpacked extension from wherever it was loaded, so a `git push` never
        // reaches the operator's copy. Stamping the build means the server log says which
        // version is reporting, instead of us inferring it from behaviour.
        'x-bridge-version': chrome.runtime.getManifest().version,
      },
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
  if (msg && msg.type === 'amz-work') {
    (async () => {
      const c = await cfg();
      if (!c.enabled) return sendResponse({ items: [], enabled: false });
      const work = await fetchWork();
      sendResponse({
        ...work, enabled: true,
        concurrency: c.concurrency, cycleDelaySec: c.cycleDelaySec, gapMs: c.gapMs,
      });
    })();
    return true;
  }
  if (msg && msg.type === 'amz-results') {
    (async () => sendResponse(await pushResults(msg.records || [])))();
    return true;
  }
  if (msg && msg.type === 'amz-note') {
    record({ note: msg.text });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'amz-refresh') {
    (async () => { await ensureTab(true); sendResponse({ ok: true }); })();
    return true;
  }
  return false;
});

/**
 * Keep exactly one pinned bridge tab.
 *
 * The `tcgbridge=1` marker is what stops the content script running in the client's OWN Amazon
 * tabs. They shop and buy on this site; a read loop inside a signed-in browsing session would be
 * both wrong and a good way to get that account's session scored.
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
 *
 * The limit must clear a full challenge pause, or the watchdog would re-navigate the tab in the
 * middle of the hour the bridge is deliberately sitting still.
 */
async function watchdog() {
  const c = await cfg();
  if (!c.enabled) return;
  const { lastPushAt = 0 } = await chrome.storage.local.get({ lastPushAt: 0 });
  const limit = Math.max(75 * 60 * 1000, (c.cycleDelaySec * 1000 + 120000) * 3);
  if (lastPushAt === 0 || Date.now() - lastPushAt > limit) {
    record({ note: `no push for ${Math.round((Date.now() - lastPushAt) / 1000)}s — restarting the tab` });
    await ensureTab(true);
  }
}

chrome.alarms.create('amz-ensure', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'amz-ensure') return;
  await ensureTab();
  await watchdog();
});

chrome.runtime.onInstalled.addListener(() => ensureTab(true));
chrome.runtime.onStartup.addListener(() => ensureTab(true));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k in DEFAULTS)) ensureTab(true);
});
