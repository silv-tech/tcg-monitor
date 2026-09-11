/**
 * TCG Monitor — Pokemon Center bridge, ISOLATED world.
 *
 * This half owns the loop and the extension plumbing. It deliberately does NOT fetch: reading
 * pages happens in page.js, in the page's own JavaScript world.
 *
 * Why the split. Fetching from here — the isolated content-script world — returned "20 pages
 * parsed nothing" against the live site on 2026-09-11: twenty reads, zero usable pages, while
 * the identical URLs fetched by hand returned 451-459KB with a valid Product ld+json. Those hand
 * tests had been run in the MAIN world without my realising it, so they never exercised this
 * path at all. In MV3 an isolated-world fetch is not the page making a request, and a service
 * that scores request provenance can tell the difference.
 *
 * `chrome.runtime` does not exist in the MAIN world, so page.js cannot reach the background
 * worker itself. This script is the relay: it holds the loop, asks the worker for work, hands it
 * to page.js over window.postMessage, and sends the results back.
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
