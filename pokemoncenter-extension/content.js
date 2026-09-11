/**
 * TCG Monitor — Pokemon Center bridge, ISOLATED world.
 *
 * This half owns the loop and the extension plumbing; the reading itself happens in page.js.
 *
 * WHY THE SPLIT EXISTS, HONESTLY. When the bridge read 0 of 20 pages I concluded the isolated
 * world was the cause and moved the fetching into the page's MAIN world. That diagnosis was
 * WRONG. Per Chromium's own url_request.mojom, an XHR from a content script injected into a page
 * carries the PAGE as its request_initiator; the extension identity is dropped by default;
 * Sec-Fetch-* is derived from that initiator with no isolated-world branch; and Chrome 85
 * deliberately aligned content-script fetches with page fetches. On the wire, an isolated-world
 * same-origin fetch IS the page asking.
 *
 * Our own logs said the same and I misread them: "http200 no-ld 447kb" — twenty healthy pages
 * arriving from the ISOLATED world, with nothing extracted. The real fault was the parser, which
 * demanded `offers.availability`, a field that products with SIZES do not carry.
 *
 * The split is kept because it is deployed and working, not because it is required. If it ever
 * needs simplifying, this file can absorb page.js and drop the Chrome 111 floor. What must NOT
 * happen is someone reading this and concluding the MAIN world is load-bearing for reading — it
 * is not, and believing so cost a release. When pages do not read, read the miss reasons.
 */

// Only ever run in the dedicated bridge tab. The user shops on this site; a read loop firing
// inside their own browsing session would be wrong, and a good way to get that session scored.
const IS_BRIDGE_TAB = new URLSearchParams(location.search).get('tcgbridge') === '1';

const TAG = 'tcg-pc-bridge';
// A block means stop, not slow down. DataDome has already cost this user their home network and
// their phone on another site, and Pokemon Center is a store they buy from personally.
const CHALLENGE_BACKOFF_MS = 30 * 60 * 1000;
const ERROR_BACKOFF_MS = 2 * 60 * 1000;
// A batch bounds its own duration; this is the ceiling on waiting for page.js to answer at all.
const PAGE_TIMEOUT_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
  catch { resolve(null); }
});

let seq = 0;

/** Hand a batch to the page world and wait for its answer. */
function readInPage(items, concurrency) {
  return new Promise((resolve) => {
    const id = ++seq;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      resolve(v);
    };
    function onMsg(ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.tag !== TAG || d.dir !== 'res' || d.id !== id) return;
      finish(d);
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ tag: TAG, dir: 'req', id, items, concurrency }, location.origin);
    // If page.js never loaded, say so plainly rather than hanging the loop for ever.
    setTimeout(() => finish({
      records: [], misses: items.length, summary: 'page world did not answer — is page.js loaded?',
    }), PAGE_TIMEOUT_MS);
  });
}

async function cycle() {
  if (!IS_BRIDGE_TAB) return;

  const work = await send({ type: 'pc-work' });
  if (!work) { await sleep(ERROR_BACKOFF_MS); return cycle(); }          // worker asleep or reloading
  if (!work.enabled) { await sleep(60000); return cycle(); }
  if (!work.items || work.items.length === 0) { await sleep(60000); return cycle(); }

  const { records, blocked, misses, summary } = await readInPage(work.items, work.concurrency || 2);

  if (records && records.length > 0) await send({ type: 'pc-results', records });

  if (blocked) {
    await send({ type: 'pc-note', text: `blocked (${blocked}) — pausing ${CHALLENGE_BACKOFF_MS / 60000}min` });
    await sleep(CHALLENGE_BACKOFF_MS);
    return cycle();
  }
  if (misses > 0 && (!records || records.length === 0)) {
    await send({ type: 'pc-note', text: `${misses} read nothing — ${summary || 'no detail'}` });
    await sleep(ERROR_BACKOFF_MS);
    return cycle();
  }

  await sleep(Math.max(1, work.cycleDelaySec || 5) * 1000);
  return cycle();
}

if (IS_BRIDGE_TAB) cycle();
