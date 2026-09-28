/**
 * TCG Monitor — Amazon checkout, background worker.
 *
 * Holds one long-poll open against the monitor and reacts the instant a watched ASIN restocks.
 * This is the latency path: from the monitor publishing a trigger to a checkout tab opening
 * should be tens of milliseconds, so there is no polling interval and no queue in between.
 *
 * WHY A LONG-POLL AND NOT A WEBSOCKET. An MV3 service worker has no EventSource and is evicted
 * after ~30s idle. A long-poll is one ordinary fetch that keeps the worker alive for as long as
 * it is in flight, which is most of the time, and the alarm below covers the gaps. The
 * competitor product uses a WebSocket plus a 1-minute keepalive alarm for exactly the same
 * reason — this gets the same result without a second protocol.
 *
 * WHY A CURSOR. Their design broadcasts and dedupes on a message id, so a trigger fired while a
 * client is reconnecting is simply gone — and reconnects cluster precisely when a drop is
 * happening. We ask for "everything after N", so a reconnect inside the server's buffer window
 * misses nothing.
 */

importScripts('guards.js');

const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  armed: false,          // the kill switch. OFF until a human turns it on, every time.
  autoSubmit: false,     // false = stop at the review page. Also off by default.
  items: [],             // [{ asin, name, quantity, maxPrice, allowUnverifiedSeller }]
  cursor: 0,
  backoffUntil: 0,
  boughtAt: {},          // asin -> when we last bought it, so one restock buys once
};

// The server parks a request for 25s; give it room before treating silence as a fault.
const POLL_WAIT_MS = 25000;
const FETCH_TIMEOUT_MS = 40000;
// A challenge means stop and let the human look. Never retry into a captcha.
const CHALLENGE_BACKOFF_MS = 30 * 60 * 1000;
// One restock buys once. Long enough to cover a flapping feed, short enough that a genuine
// second drop the same hour is still catchable.
const BUY_COOLDOWN_MS = 10 * 60 * 1000;

let polling = false;

/**
 * The log lives in storage, not in a module array.
 *
 * An MV3 worker is evicted after ~30s idle, and a module-level array is reset on every cold
 * start — so the first entry after any restart used to overwrite the whole history, including
 * the record of what had been bought. For a tool that spends money that array IS the audit trail.
 */
async function record(entry) {
  const { acoLog = [] } = await chrome.storage.local.get({ acoLog: [] });
  acoLog.unshift({ at: new Date().toISOString(), ...entry });
  await chrome.storage.local.set({ acoLog: acoLog.slice(0, 80) });
}

async function cfg() {
  const c = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...c };
}

const apiBase = (u) => String(u || '').replace(/\/+$/, '');

/** The armed row for an ASIN, or null. Matching lives in guards.js; this only looks it up. */
function armedFor(items, asin) {
  const want = String(asin || '').trim().toUpperCase();
  return (items || []).find(i => String(i.asin || '').trim().toUpperCase() === want) || null;
}

async function pollOnce() {
  const c = await cfg();
  if (!c.baseUrl || !c.apiKey) {
    record({ error: 'not configured — open the side panel' });
    return { ok: false, waitMs: 60000 };
  }

  const url = `${apiBase(c.baseUrl)}/api/checkout/next?since=${encodeURIComponent(c.cursor)}`
    + `&wait=${POLL_WAIT_MS}`;

  try {
    const res = await fetch(url, {
      headers: { 'x-api-key': c.apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      record({ error: `feed HTTP ${res.status}` });
      return { ok: false, waitMs: res.status === 401 || res.status === 403 ? 60000 : 5000 };
    }
    const body = await res.json();

    // Advance the cursor even when nothing arrived: the server ages entries out, and a client
    // that never advances would re-request a window that no longer exists, forever.
    if (Number.isFinite(body.cursor)) await chrome.storage.local.set({ cursor: body.cursor });

    for (const trigger of body.items || []) await handleTrigger(trigger, c);
    return { ok: true, waitMs: 0 };
  } catch (err) {
    // A timeout on a long-poll is normal — the server answered with nothing and the socket idled.
    const benign = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (!benign) record({ error: `feed: ${err.message}` });
    return { ok: true, waitMs: benign ? 0 : 5000 };
  }
}

async function handleTrigger(trigger, _stale) {
  // RE-READ THE CONFIG. The snapshot the poll started with can be up to 40 seconds old, and
  // "Stop all" is precisely the thing a human presses during those 40 seconds. Deciding from the
  // stale copy placed real orders after the kill switch had been pressed.
  const c = await cfg();

  const armed = armedFor(c.items, trigger.asin);
  // Not on the list is the common case and is not worth a log line — the feed carries every
  // Amazon restock, and a user watches a handful.
  if (!armed) return;

  // A challenge pause must hold for every trigger in the batch, not just the one that tripped it.
  if (Date.now() < (c.backoffUntil || 0)) {
    record({ asin: trigger.asin, note: 'skipped — paused after a challenge' });
    return;
  }

  // ONE RESTOCK, ONE ORDER. The feed can carry the same ASIN twice in a batch (flapping stock),
  // and without this the loop opens two tabs and buys twice on the same card.
  const bought = c.boughtAt || {};
  const since = Date.now() - (bought[trigger.asin] || 0);
  if (since < BUY_COOLDOWN_MS) {
    record({ asin: trigger.asin, note: `skipped — bought ${Math.round(since / 1000)}s ago` });
    return;
  }

  const d = decide(trigger, armed, { now: Date.now(), armedGlobally: c.armed });
  if (!d.buy) {
    record({ asin: trigger.asin, note: `skipped — ${d.reason}` });
    report(c, { asin: trigger.asin, outcome: outcomeFor(d.reason), detail: d.reason });
    return;
  }

  record({ asin: trigger.asin, note: `BUYING — $${trigger.price} x${clampQuantity(armed.quantity)}` });
  await runCheckout(trigger, armed, c);
}

/** Map a refusal reason onto the server's closed outcome vocabulary, for the log. */
function outcomeFor(reason) {
  if (/over max/.test(reason)) return 'price_too_high';
  if (/seller not verified/.test(reason)) return 'unverified_seller';
  if (/disarmed|not armed|asin mismatch|stale/.test(reason)) return 'skipped';
  return 'skipped';
}

/**
 * Open a checkout tab and hand it to the runner.
 *
 * A fresh tab per attempt, never a reused one: Amazon's checkout is a state machine and a tab
 * part-way through a previous attempt is the fastest way to submit the wrong thing.
 */
async function runCheckout(trigger, armed, c) {
  const started = Date.now();

  // A HAND-ENTERED OFFER ID WINS over the one the trigger carried.
  //
  // This is how you buy one specific offer: paste its id from any alert — ours or a competitor's
  // — into the saved item, and every checkout for that ASIN targets exactly that offer instead of
  // whichever one our monitor happened to see. Without it you are always buying the buy box as it
  // stood at alert time.
  const offerId = String(armed.offerId || '').trim() || trigger.offerId;

  // No offer id at all means we cannot pin what Amazon will sell. Rather than open a bare Buy Now
  // entry — which lets Amazon substitute whatever is in the buy box, the exact thing the offering
  // id exists to prevent — go to the product page and stop. A human decides.
  const pinned = buyNowUrl(trigger.asin, offerId, armed.quantity);
  if (!pinned) {
    record({ asin: trigger.asin, note: 'no offer id on the trigger — opening the product page only' });
    await chrome.tabs.create({ url: productUrl(trigger.asin), active: false });
    report(c, { asin: trigger.asin, outcome: 'skipped', detail: 'no offer id to pin the buy to' });
    return;
  }
  const url = pinned;

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (err) {
    record({ asin: trigger.asin, error: `could not open tab: ${err.message}` });
    return;
  }

  try {
    // WAIT FOR THE TAB TO SETTLE FIRST. `tabs.create` resolves long before the page exists, and
    // Amazon's Buy Now entry REDIRECTS (buynow -> /checkout/p/<id>/spc). A content script
    // injected before that redirect is destroyed by it, and the sendMessage below would then
    // hang until it timed out — on every single checkout.
    const settled = await waitForTabLoad(tab.id, 20000);
    if (!settled) {
      record({ asin: trigger.asin, error: 'checkout tab never finished loading' });
      report(c, { asin: trigger.asin, outcome: 'failed', detail: 'tab load timeout' });
      return;
    }

    // BOTH files, guards first. guards.js is loaded by importScripts into the SERVICE WORKER,
    // which is a different context entirely — the page has never seen it. Injecting only
    // runner.js throws ReferenceError on its first guard call. They land in the same isolated
    // world in the order given, so runner.js sees guards.js's top-level functions.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['guards.js', 'runner.js'],
    });

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'aco-run',
      intent: {
        asin: trigger.asin,
        maxPrice: Number(armed.maxPrice),
        quantity: clampQuantity(armed.quantity),
        // The buy is pinned to one offer, so the checkout total is determined even if we cannot
        // read it off the page. Without this the ceiling check refuses an unreadable total.
        offerPinned: true,
        autoSubmit: c.autoSubmit === true,
      },
    });

    const elapsedMs = Date.now() - started;
    record({ asin: trigger.asin, note: `${result?.outcome || 'no answer'} in ${elapsedMs}ms`
      + `${result?.detail ? ` — ${result.detail}` : ''}` });
    report(c, { asin: trigger.asin, outcome: result?.outcome || 'failed',
      detail: result?.detail, price: result?.price, elapsedMs });

    if (result?.outcome === 'blocked') {
      // Persisted, because module state dies with the worker — and the worker idles out within
      // ~30s of the pause starting, so the intended 30 MINUTES lasted about 30 SECONDS and then
      // drove straight back into Amazon's challenge.
      await chrome.storage.local.set({ backoffUntil: Date.now() + CHALLENGE_BACKOFF_MS });
      await record({ note: `challenge seen — pausing ${CHALLENGE_BACKOFF_MS / 60000}min. Check the tab.` });
    }
    // `submitted` means the form went in and the page navigated away, taking the runner with it.
    // Confirmation has to come from the tab, not from the dead document — an earlier draft waited
    // inside that document and so reported every successful order as `failed`.
    if (result?.outcome === 'submitted') {
      const confirmed = await waitForThankYou(tab.id, 30000);
      result.outcome = confirmed ? 'ordered' : 'submitted';
      result.detail = confirmed
        ? 'Amazon confirmed the order'
        : 'submitted but Amazon did not confirm — CHECK THIS TAB before retrying';
    }
    if (result?.outcome === 'submitted' || result?.outcome === 'ordered') {
      const { boughtAt = {} } = await chrome.storage.local.get({ boughtAt: {} });
      boughtAt[trigger.asin] = Date.now();
      await chrome.storage.local.set({ boughtAt });
    }
    // The tab is deliberately LEFT OPEN on every outcome. If it ordered, the user wants the
    // confirmation; if it stopped at review, they need to finish it; if it was challenged, they
    // have to solve it. Closing it would hide all three.
  } catch (err) {
    record({ asin: trigger.asin, error: `runner: ${err.message}` });
    report(c, { asin: trigger.asin, outcome: 'failed', detail: err.message,
      elapsedMs: Date.now() - started });
  }
}

/**
 * Resolve once the tab has finished loading, following redirects.
 *
 * Amazon's buynow entry bounces to the single-page checkout, and each hop tears down any injected
 * script. Waiting for `status === 'complete'` on the settled URL is what makes one injection
 * enough. Bounded, because a tab that never completes must not hold the loop open.
 */
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    // A tab the user closed mid-checkout must fail fast rather than wait out the timeout.
    const onRemoved = (id) => { if (id === tabId) finish(false); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // It may already be done before the listener was attached.
    chrome.tabs.get(tabId).then(t => { if (t && t.status === 'complete') finish(true); }).catch(() => finish(false));
  });
}

/**
 * Watch the tab for Amazon's confirmation page.
 *
 * Resolving false does NOT mean the order failed — it means we do not know, which is why the
 * caller reports `submitted` rather than `failed`. A submit of unknown outcome must never look
 * retryable; the cost of assuming failure is buying the same thing twice.
 */
function waitForThankYou(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onUpdated = (id, info, tab) => {
      if (id !== tabId) return;
      const u = info.url || (tab && tab.url) || '';
      if (u && pageStateOf(u) === 'thankyou') finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(t => { if (t && pageStateOf(t.url || '') === 'thankyou') finish(true); })
      .catch(() => finish(false));
  });
}

/** Tell the monitor what happened. Best effort — a lost log line must never stall the loop. */
function report(c, body) {
  try {
    fetch(`${apiBase(c.baseUrl)}/api/checkout/result`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.apiKey,
        'x-aco-version': chrome.runtime.getManifest().version,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch { /* ignore */ }
}

/**
 * The loop. One poll at a time, restarted by the alarm if it ever stops.
 *
 * Liveness is "is a poll in flight", not "did we start once" — the EB Games bridge lost eight
 * minutes with no symptom when a reload orphaned its loop, and nothing noticed because the thing
 * that was checked was still nominally true.
 */
async function loop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const c = await cfg();
      if (!c.armed) { polling = false; return; }
      if (Date.now() < (c.backoffUntil || 0)) { polling = false; return; }
      const { waitMs } = await pollOnce();
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    }
  } finally {
    polling = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'aco-status') {
    (async () => {
      const c = await cfg();
      sendResponse({ armed: c.armed, polling, backoffUntil: c.backoffUntil || 0, cursor: c.cursor, items: c.items.length });
    })();
    return true;
  }
  if (msg?.type === 'aco-kick') {
    chrome.storage.local.set({ backoffUntil: 0 }).then(() => loop());
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.alarms.create('aco-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'aco-keepalive') loop(); });
chrome.runtime.onInstalled.addListener(() => loop());
chrome.runtime.onStartup.addListener(() => loop());
chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ windowId: tab.windowId }));
chrome.storage.onChanged.addListener(() => loop());
// Any cold start should resume immediately. loop() is idempotent and returns at once when
// disarmed — without this, saving settings woke the worker, reset the alarm to +60s, and left a
// full minute with nothing polling.
loop();
