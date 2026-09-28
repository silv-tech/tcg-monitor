/**
 * TCG Monitor — Amazon bridge, ISOLATED world.
 *
 * This half owns the loop and the extension plumbing. It deliberately does NOT fetch: reading
 * pages happens in page.js, in the page's own JavaScript world, because in MV3 an isolated-world
 * fetch is not the page making a request and Amazon can tell the difference. See page.js.
 *
 * `chrome.runtime` does not exist in the MAIN world, so page.js cannot reach the background
 * worker itself. This script is the relay: it holds the loop, asks the worker for work, hands it
 * to page.js over window.postMessage, and sends the results back.
 */

// Only ever run in the dedicated bridge tab. The client BUYS from Amazon; a read loop firing
// inside their own shopping session would be wrong, and the fastest way to get that session —
// and the account attached to it — scored.
const IS_BRIDGE_TAB = new URLSearchParams(location.search).get('tcgbridge') === '1';

const TAG = 'tcg-amz-bridge';
// A block means stop, not slow down. DataDome has already cost this user their home network and
// their phone on another site, and Amazon is a store they buy from personally. An hour, double
// the Pokemon Center bridge, because a challenged Amazon session can follow the account.
const CHALLENGE_BACKOFF_MS = 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 2 * 60 * 1000;
// A batch bounds its own duration; this is the ceiling on waiting for page.js to answer at all.
const PAGE_TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => new Promise((resolve) => {
  try { chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r)); }
  catch { resolve(null); }
});

let seq = 0;

/** Hand a batch to the page world and wait for its answer. */
function readInPage(items, concurrency, gapMs) {
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
    window.postMessage({ tag: TAG, dir: 'req', id, items, concurrency, gapMs }, location.origin);
    // If page.js never loaded, say so plainly rather than hanging the loop for ever.
    setTimeout(() => finish({
      records: [], misses: items.length, summary: 'page world did not answer — is page.js loaded?',
    }), PAGE_TIMEOUT_MS);
  });
}

async function cycle() {
  if (!IS_BRIDGE_TAB) return;

  const work = await send({ type: 'amz-work' });
  if (!work) { await sleep(ERROR_BACKOFF_MS); return cycle(); }          // worker asleep or reloading
  if (!work.enabled) { await sleep(60000); return cycle(); }
  if (!work.items || work.items.length === 0) { await sleep(60000); return cycle(); }

  const { records, blocked, misses, summary } = await readInPage(
    work.items, work.concurrency || 1, work.gapMs
  );

  if (records && records.length > 0) await send({ type: 'amz-results', records });

  if (blocked) {
    await send({ type: 'amz-note', text: `blocked (${blocked}) — pausing ${CHALLENGE_BACKOFF_MS / 60000}min` });
    await sleep(CHALLENGE_BACKOFF_MS);
    return cycle();
  }
  if (misses > 0 && (!records || records.length === 0)) {
    await send({ type: 'amz-note', text: `${misses} read nothing — ${summary || 'no detail'}` });
    await sleep(ERROR_BACKOFF_MS);
    return cycle();
  }

  await sleep(Math.max(1, work.cycleDelaySec || 20) * 1000);
  return cycle();
}

if (IS_BRIDGE_TAB) cycle();
