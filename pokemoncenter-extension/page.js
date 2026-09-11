/**
 * TCG Monitor — Pokemon Center bridge, PAGE world.
 *
 * This file runs in the page's OWN JavaScript world (`"world": "MAIN"` in the manifest), not in
 * the extension's isolated world, and that distinction is the whole reason it exists.
 *
 * BUT NOT FOR THE REASON ORIGINALLY GIVEN, and the record is corrected here because the wrong
 * reason shipped. When the bridge read 0 of 20 pages I concluded the isolated content-script
 * world was refusing to carry the session, and moved the fetching here. That was wrong. Per
 * Chromium's url_request.mojom, an XHR from a content script injected into a page carries the
 * PAGE as its request_initiator; the extension identity is dropped by default;
 * services/network/sec_header_helpers.cc derives Sec-Fetch-* from that initiator with no
 * isolated-world branch; and Chrome 85 deliberately aligned content-script fetches with page
 * fetches. On the wire the two are the same request.
 *
 * The logs said so too, and I misread them: "http200 no-ld 447kb" was twenty healthy pages
 * arriving from the ISOLATED world with nothing extracted. The real fault was the parser below,
 * which demanded `offers.availability` — a field products with SIZES do not carry.
 *
 * This file is kept because it is deployed and working, not because the MAIN world is required
 * for reading. It is not. Do not move code here to fix a reading problem; read the miss reasons.
 *
 * The cost is that `chrome.runtime` does not exist in this world, so everything reaches the
 * extension through window.postMessage. Only the ld+json block is passed back: a product page is
 * ~440KB and the block ~1.3KB, so a full 8,415-product pass moves ~11MB instead of ~3.7GB, and
 * the monitor keeps parsing with the one parser it already had.
 */

(() => {
  const TAG = 'tcg-pc-bridge';

  /**
   * Pull the Product ld+json out of a fetched page.
   *
   * Returns the RAW block text so the monitor does the parsing — one parser, server-side, rather
   * than a second copy here that would drift out of step with the site.
   */
  function extractProductLd(html) {
    for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
      const raw = m[1].trim();
      let json;
      try { json = JSON.parse(raw); } catch { continue; }
      if (json['@type'] !== 'Product') continue;

      // Pokemon Center uses TWO offer shapes, and requiring only the first threw away 7,610 of
      // the store's 8,415 products:
      //   Offer           a single item     { availability, price }
      //   AggregateOffer  anything SIZED    { lowPrice, offers:[ {sku, availability, price} ] }
      // Measured 2026-09-11 — the TCG zip binder is the first, the Crocs clog the second with
      // nine size variants. Demanding `offers.availability` made every clothing and footwear
      // page read as "no product data": twenty good 447KB pages, nothing extracted.
      //
      // The check stays deliberately loose — the server owns the parsing. It only has to be
      // tight enough to reject the category listing's Product cells, which carry no offers at
      // all beyond a constant OutOfStock and an empty sku.
      const list = Array.isArray(json.offers) ? json.offers : [json.offers];
      const usable = list.some((o) => o && (o.availability
        || (Array.isArray(o.offers) && o.offers.some((v) => v && v.availability))));
      if (!usable) continue;
      return raw;
    }
    return null;
  }

  /**
   * Is this a bot wall, or just a page we did not get?
   *
   * An earlier version answered "anything under 5000 bytes is a block" and turned a single
   * 1053-byte response into a 30-minute halt. The user saw no challenge, the next cycles fetched
   * normally, and re-fetching those URLs returned 200/459KB — a real challenge does not heal
   * itself. Size alone is not evidence.
   *
   * Nor are the markers alone: DataDome's scripts load on perfectly good Pokemon Center pages,
   * and the monitor's adapter carries a note about that exact mistake discarding every real page.
   * A block is HTTP 429, or a body both too small to be a page AND carrying challenge markup.
   */
  function looksBlocked(html, res) {
    if (res && res.status === 429) return true;
    if (!html) return true;
    if (html.length >= 5000) return false;
    return /captcha-delivery|geo\.captcha|Pardon Our Interruption|Just a moment/i.test(html);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function readOne(item) {
    const res = await fetch(item.url, { credentials: 'include', redirect: 'follow' });
    const html = await res.text();
    if (looksBlocked(html, res)) {
      return { blocked: res.status === 429 ? 'HTTP 429' : `challenge (${html.length}b)` };
    }
    // Every miss carries its reason. "parsed nothing" was a true statement that identified
    // nothing, and diagnosing the first live failure meant guessing.
    if (html.length < 5000) return { miss: `http${res.status} short ${html.length}b` };
    const ld = extractProductLd(html);
    if (!ld) return { miss: `http${res.status} no-ld ${Math.round(html.length / 1024)}kb` };
    return { record: { sku: item.sku, ld } };
  }

  async function readBatch(items, concurrency) {
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
        await sleep(200 + Math.floor(Math.random() * 400));
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(6, concurrency)) }, worker));
    const summary = Object.entries(why).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${v}x ${k}`).join(' | ');
    return { records, blocked, misses, summary };
  }

  // Exported for tests only. A content script has no `module`, so the guard below runs instead.
  if (typeof module !== 'undefined') { module.exports = { extractProductLd, looksBlocked }; return; }

  // Inert outside the dedicated bridge tab — the user shops on this site.
  if (new URLSearchParams(location.search).get('tcgbridge') !== '1') return;

  // Any script on the page can postMessage, so only ever act on our own tagged requests, and
  // only from this window. The server independently refuses any SKU its sitemap does not list,
  // so a forged reply cannot invent a product either.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.tag !== TAG || d.dir !== 'req' || !Array.isArray(d.items)) return;
    const out = await readBatch(d.items, d.concurrency || 2);
    window.postMessage({ tag: TAG, dir: 'res', id: d.id, ...out }, location.origin);
  });

  window.postMessage({ tag: TAG, dir: 'ready' }, location.origin);
})();
