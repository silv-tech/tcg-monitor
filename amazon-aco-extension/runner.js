/**
 * TCG Monitor — Amazon checkout, page runner.
 *
 * Runs on ONE page state: Amazon's single-page checkout (`/checkout/p/<id>/spc`). The background
 * worker is responsible for getting the tab there; this file refuses to act anywhere else.
 *
 * EVERY SELECTOR HERE IS COPIED FROM A COMPETITOR'S SHIPPING BUILD, not invented. An earlier
 * draft used `#placeYourOrder`, `#submitOrderButtonId`, `.grand-total-price` and friends — all of
 * which belong to Amazon's pre-2021 checkout and match nothing today. That draft would have
 * reported "place-order control not found" on every single run, and — far worse — its price read
 * returned null, which the ceiling check silently treated as "fine". A guard that cannot read its
 * input must refuse, never shrug.
 *
 * THE IDENTITY CHECK MUST USE AMAZON'S CLAIM, NOT OURS. The same earlier draft read the ASIN from
 * `location.search`, which the extension itself had written. It compared our intent to our own
 * query string and could never fail. Identity now comes only from `.lineitem-container`
 * descendants — the one place Amazon states what it is about to sell.
 */

(() => {
  const SETTLE_MS = 15000;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /**
   * Poll for a condition. Driven by rAF as well as a timer because the checkout tab is opened in
   * the background, and Chrome clamps setTimeout in hidden tabs to roughly one second.
   */
  async function until(fn, budgetMs = SETTLE_MS) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      try { const v = fn(); if (v) return v; } catch { /* mid-render */ }
      if (Date.now() >= deadline) return null;
      await new Promise(r => { requestAnimationFrame(() => r()); setTimeout(r, 60); });
    }
  }

  const visible = (el) => {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  /**
   * Every ASIN Amazon shows in the checkout's line items.
   *
   * A Set, not a first match: a document-wide `a[href*="/dp/"]` grabs a recommendation carousel
   * link long before it reaches the thing being bought.
   *
   * @returns {Set<string>|null} null when the line items have not rendered — which is
   *          INCONCLUSIVE, and inconclusive must refuse.
   */
  function readCheckoutAsins() {
    const rows = document.querySelectorAll('.lineitem-container');
    if (rows.length === 0) return null;
    const found = new Set();
    for (const row of rows) {
      for (const el of row.querySelectorAll('a[href], input[value], [data-asin]')) {
        const da = el.getAttribute && el.getAttribute('data-asin');
        if (da && /^[A-Z0-9]{10}$/i.test(da.trim())) found.add(da.trim().toUpperCase());
        const href = el.getAttribute && el.getAttribute('href');
        const hm = href && href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
        if (hm) found.add(hm[1].toUpperCase());
        const val = el.value;
        if (val && /^[A-Z0-9]{10}$/i.test(String(val).trim())) found.add(String(val).trim().toUpperCase());
      }
    }
    return found;
  }

  function readLineItemCount() {
    const n = document.querySelectorAll('.lineitem-container').length;
    return n > 0 ? n : null;   // null = could not tell, which verifyCheckoutPage refuses
  }

  /**
   * The order total.
   *
   * No proven selector exists for this — the competitor reads no price on Amazon at all, relying
   * instead on the pinned offering id to determine what is being bought. So this is best effort,
   * and the caller is told the difference between "read it" and "could not".
   *
   * Handles fr-CA, which amazon.ca serves to a large share of users: "62,14 $" must not be parsed
   * as 6214 and then rejected as a price spike forever.
   */
  function readPrice() {
    const nodes = document.querySelectorAll(
      '[data-testid*="grand-total"], [class*="grand-total"], #subtotals-marketplace-table td, '
      + '.order-summary-line-definition, .a-color-price',
    );
    for (const el of nodes) {
      const raw = (el.textContent || '').trim();
      if (!/\d/.test(raw)) continue;
      const v = parseMoney(raw);
      if (v != null) return v;
    }
    return null;
  }

  /** "$62.14", "62,14 $", "CDN$ 1,299.99" -> number. Decimal separator detected, not assumed. */
  function parseMoney(text) {
    const m = String(text).match(/\d[\d\s.,]*/);
    if (!m) return null;
    let s = m[0].replace(/\s/g, '');
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    const sep = Math.max(lastComma, lastDot);
    // A separator followed by exactly two digits is the decimal point; anything else is grouping.
    if (sep > -1 && s.length - sep - 1 === 2) {
      s = s.slice(0, sep).replace(/[.,]/g, '') + '.' + s.slice(sep + 1);
    } else {
      s = s.replace(/[.,]/g, '');
    }
    const v = Number(s);
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  /**
   * The place-order control, found STRUCTURALLY.
   *
   * Amazon's modern checkout exposes no stable id for it. What is stable is the form it belongs
   * to: a POST whose action path ends in `/place-order`. That is how the competitor's shipping
   * build finds it, and it is the only approach that survives their markup churn.
   */
  /**
   * What this page ACTUALLY contains, for when a read fails.
   *
   * The whole checkout read hangs on selectors that have never been run against a live Amazon
   * checkout — nobody on this project can load one to check. "checkout never rendered its line
   * items" is a true statement that identifies nothing, and it is what the operator would have
   * been left holding after the first real run.
   *
   * The browser bridge learned this the expensive way: reporting WHICH selectors matched turns a
   * guessing game into one line that names the broken selector. Same trick here. Counts only —
   * never page text, because a checkout page carries an address and an order total.
   */
  function probe() {
    const counts = {};
    const SEEN = {
      lineitem: '.lineitem-container',
      dpLinks: 'a[href*="/dp/"]',
      dataAsin: '[data-asin]',
      submits: 'input[type="submit"], button[type="submit"]',
      forms: 'form',
      gridForm: 'form[action*="place-order"]',
      priceCells: '#subtotals-marketplace-table td, [class*="grand-total"], .a-color-price',
    };
    for (const [k, sel] of Object.entries(SEEN)) {
      try { counts[k] = document.querySelectorAll(sel).length; } catch { counts[k] = -1; }
    }
    const present = Object.entries(counts).filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`);
    return present.length ? present.join(' ') : 'none of the known selectors matched';
  }

  function findPlaceOrder() {
    for (const el of document.querySelectorAll('input[type="submit"], button[type="submit"]')) {
      const form = el.form;
      if (!form || form.method.toUpperCase() !== 'POST') continue;
      let path;
      try { path = new URL(form.action, location.href).pathname; } catch { continue; }
      if (!path.endsWith('/place-order')) continue;
      if (!visible(el)) continue;
      return el;
    }
    return null;
  }

  // Survives a reload, unlike a window flag. If the spc page reloads after we submitted but
  // before the confirmation lands, this is what stops a second order going in.
  const SUBMIT_KEY = 'tcgaco:submitted';

  async function run(intent) {
    const state = pageStateOf(location.href);

    if (state === 'thankyou') return { outcome: 'ordered', detail: 'already on the confirmation page' };
    if (state === 'out_of_stock') return { outcome: 'out_of_stock', detail: 'Amazon routed to its out-of-stock page' };
    if (state === 'signin') return { outcome: 'blocked', detail: 'not signed in to Amazon' };
    if (state === 'cart') return { outcome: 'wrong_identity', detail: 'this is the cart, not an isolated Buy Now' };
    if (looksChallenged(location.href, document.body ? document.body.innerText : '')) {
      return { outcome: 'blocked', detail: 'challenge — needs a human' };
    }
    if (state !== 'spc') {
      return { outcome: 'failed', detail: `not the checkout page (${state}) [${probe()}]` };
    }

    try {
      if (sessionStorage.getItem(SUBMIT_KEY)) {
        return { outcome: 'submitted', detail: 'an order was already submitted from this tab' };
      }
    } catch { /* storage blocked; the background dedup still applies */ }

    // Wait for Amazon's own content. Deliberately NOT satisfied by anything we put in the URL.
    const rendered = await until(() => readCheckoutAsins() || findPlaceOrder());
    if (!rendered) {
      return { outcome: 'failed', detail: `checkout never rendered its line items [${probe()}]` };
    }

    const asins = readCheckoutAsins();
    const page = {
      asin: asins && asins.size === 1 ? [...asins][0] : '',
      asins: asins ? [...asins] : [],
      lineItemCount: readLineItemCount(),
      price: readPrice(),
    };

    // Several ASINs in the line items means more than one product is being bought.
    if (asins && asins.size > 1 && !asins.has(String(intent.asin).toUpperCase())) {
      return { outcome: 'wrong_identity', detail: `checkout shows ${page.asins.join(', ')}` };
    }
    if (asins && asins.size > 1) {
      return { outcome: 'wrong_identity', detail: `checkout holds ${asins.size} products` };
    }

    const v = verifyCheckoutPage(page, intent);
    if (!v.ok) {
      const outcome = /over max/.test(v.reason) ? 'price_too_high' : 'wrong_identity';
      return { outcome, detail: v.reason, price: page.price };
    }

    if (!intent.autoSubmit) {
      return { outcome: 'ready_for_review', detail: 'verified, stopped before ordering', price: page.price };
    }

    const btn = await until(() => findPlaceOrder());
    if (!btn) return { outcome: 'failed', detail: 'place-order control not found', price: page.price };

    // Mark BEFORE submitting. A crash between marking and submitting costs one missed purchase;
    // the other order costs a duplicate order.
    try { sessionStorage.setItem(SUBMIT_KEY, String(Date.now())); } catch { /* ignore */ }

    const form = btn.form;
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit(btn);
    else btn.click();

    // Answer IMMEDIATELY. Submitting navigates away, which destroys this document, this listener
    // and the message channel — an earlier draft waited here for the thank-you page and so every
    // successful order was reported as `failed`. The background confirms from tab navigation.
    return { outcome: 'submitted', detail: 'order form submitted', price: page.price };
  }

  if (window.__tcgAcoRunner) return;
  window.__tcgAcoRunner = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'aco-run') return false;
    run(msg.intent)
      .then(sendResponse)
      .catch(err => sendResponse({ outcome: 'failed', detail: String(err && err.message).slice(0, 200) }));
    return true;
  });
})();
