/**
 * TCG Monitor — Amazon bridge, PAGE world.
 *
 * Runs in the page's OWN JavaScript world (`"world": "MAIN"`), not the extension's isolated
 * world, and that is the whole reason this file is separate from content.js.
 *
 * The Pokemon Center bridge learned this the expensive way: fetching from the isolated
 * content-script world read 0 of 20 pages against the live site, while the identical URLs
 * fetched by hand returned full pages every time — because those hand tests had been run in the
 * MAIN world without anyone realising it. In MV3 an isolated-world fetch is not the page making
 * a request: different credential handling, different Sec-Fetch context. A service that scores
 * request provenance can tell, and Amazon very much scores request provenance.
 *
 * Here the fetch is indistinguishable from one Amazon's own page code makes, because it is one.
 *
 * `chrome.runtime` does not exist in this world, so everything reaches the extension through
 * window.postMessage — content.js is the relay.
 */

(() => {
  const TAG = 'tcg-amz-bridge';

  /**
   * The elements the monitor needs, and nothing else.
   *
   * A /dp/ page is 400KB-1.5MB. Posting whole pages for ~780 ASINs would move ~300MB a pass, so
   * this cuts a slice of a few KB. The split of responsibility is deliberate:
   *
   *   HERE   — WHICH elements (a DOM query, in a browser that already rendered the page)
   *   SERVER — WHAT THE VALUES MEAN (pinned price => in stock, price provenance, scope)
   *
   * The value semantics stay server-side because that is where the verdict contract and its
   * tests live. Re-deriving "in stock" in here would be a second copy of the rule that Amazon's
   * layout changes could silently drift out of step with.
   */
  const SLICE = [
    '#productTitle',
    '#corePrice_feature_div',
    '#corePriceDisplay_desktop_feature_div',
    '#apex_desktop',
    '#availability',
    '#outOfStock',
    '#merchant-info',
    '#sellerProfileTriggerId',
    '#offer-display-features',
    '#add-to-cart-button',
    '#buy-now-button',
  ];

  /**
   * Pull the slice out of fetched HTML.
   *
   * Returns null when the page carries no title — a /dp/ response without one is not a product
   * page we read, it is something else wearing a 200, and the monitor's contract already calls
   * a titleless read INCONCLUSIVE rather than out-of-stock.
   */
  function extractSlice(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('#productTitle');
    if (!title || !title.textContent.trim()) return null;

    const parts = [];
    for (const sel of SLICE) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      // The add-to-cart and buy-now controls matter only by their PRESENCE, and their markup
      // carries a per-session CSRF blob. Reduce them to a marker so no token leaves the browser.
      if (sel === '#add-to-cart-button' || sel === '#buy-now-button') {
        parts.push(`<div id="${el.id}" data-tcg-present="1"></div>`);
        continue;
      }
      parts.push(el.outerHTML);
    }
    return parts.join('\n');
  }

  /**
   * Which of the SLICE selectors this page actually has.
   *
   * This exists because of where the two halves of this project live: the bridge runs on
   * Canadian Chrome against amazon.ca, and whoever maintains the parser cannot load that page —
   * geo-routing serves them something else, and putting automated traffic on a bot-scored
   * retailer from a second address is the mistake that cost this user their home network on
   * London Drugs.
   *
   * So when extraction fails, the bridge reports WHICH selectors matched rather than just
   * "nothing parsed". That names the broken selector directly — Amazon renames these blocks —
   * without shipping any page content off the operator's machine.
   */
  function probe(doc) {
    return SLICE.filter((sel) => doc.querySelector(sel)).map((sel) => sel.slice(1));
  }

  /**
   * Is this a bot wall, or just a page we did not get?
   *
   * The Pokemon Center bridge shipped "anything small is a block" and turned one 1053-byte blip
   * into a 30-minute halt; it also carries a warning that keying on vendor markers alone is
   * wrong, because those scripts load on perfectly good pages. Both lessons apply here.
   *
   * For Amazon a block is: HTTP 503 (its classic throttle answer), or the captcha interstitial —
   * which is BOTH far too small to be a product page AND carries the challenge form. Amazon's
   * real /dp/ pages are 400KB+, so the size half of that test has enormous margin.
   */
  function looksBlocked(html, res) {
    if (res && (res.status === 503 || res.status === 429)) return true;
    if (!html) return true;
    if (html.length >= 100000) return false;
    return /validateCaptcha|images-amazon\.com\/captcha|Enter the characters you see below|not a robot/i.test(html);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function readOne(item) {
    const res = await fetch(item.url, { credentials: 'include', redirect: 'follow' });
    const html = await res.text();
    if (looksBlocked(html, res)) {
      return { blocked: res.status === 503 || res.status === 429 ? `HTTP ${res.status}` : `captcha (${html.length}b)` };
    }
    // Every miss carries its reason. "parsed nothing" is a true statement that identifies
    // nothing, and it made the first live Pokemon Center failure a guessing game.
    if (html.length < 100000) return { miss: `http${res.status} short ${html.length}b` };
    const slice = extractSlice(html);
    if (!slice) {
      // Name the selectors that DID match, so a renamed block is diagnosable from the options
      // log alone — see probe(). "parsed nothing" is a true statement that identifies nothing.
      const found = probe(new DOMParser().parseFromString(html, 'text/html'));
      return {
        miss: `http${res.status} no-title ${Math.round(html.length / 1024)}kb `
          + `[${found.length ? found.join(',') : 'no known ids'}]`,
      };
    }
    return { record: { asin: item.asin, slice } };
  }

  async function readBatch(items, concurrency, gapMs) {
    const records = [];
    const why = {};
    let blocked = null;
    let misses = 0;
    let next = 0;
    const note = (r) => { misses++; why[r] = (why[r] || 0) + 1; };

    async function worker() {
      while (next < items.length && !blocked) {
        const item = items[next++];
        try {
          const r = await readOne(item);
          if (r.blocked) { blocked = r.blocked; break; }
          if (r.miss) note(r.miss);
          else records.push(r.record);
        } catch (err) {
          note(`threw: ${String(err && err.message).slice(0, 40)}`);
        }
        // Jittered, and slower than the Pokemon Center bridge on purpose. This is the retailer
        // the client actually buys from and the one most willing to challenge a session.
        const base = Math.max(400, Number(gapMs) || 900);
        await sleep(base + Math.floor(Math.random() * base));
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, worker));
    const summary = Object.entries(why).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v}x ${k}`).join(' | ');
    return { records, blocked, misses, summary };
  }

  // Exported for tests only. A content script has no `module`, so the guard below runs instead.
  if (typeof module !== 'undefined') { module.exports = { extractSlice, looksBlocked, probe, SLICE }; return; }

  // Inert outside the dedicated bridge tab — the user shops on this site.
  if (new URLSearchParams(location.search).get('tcgbridge') !== '1') return;

  // Any script on the page can postMessage, so only ever act on our own tagged requests, and
  // only from this window. The server independently refuses any ASIN it does not already track,
  // so a forged reply cannot invent a product either.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.tag !== TAG || d.dir !== 'req' || !Array.isArray(d.items)) return;
    const out = await readBatch(d.items, d.concurrency || 1, d.gapMs);
    window.postMessage({ tag: TAG, dir: 'res', id: d.id, ...out }, location.origin);
  });

  window.postMessage({ tag: TAG, dir: 'ready' }, location.origin);
})();
