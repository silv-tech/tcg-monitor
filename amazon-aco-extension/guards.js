/**
 * Every reason this extension is allowed to refuse to spend money.
 *
 * Kept in one file, as pure functions, for one reason: these are the only thing standing between
 * a monitor alert and a charge on a real card, and logic buried in a click handler cannot be
 * tested. Everything here is a decision; nothing here touches the DOM or the network.
 *
 * A guard that returns `{ buy: false }` is never an error. Refusing to buy is the safe outcome
 * and must always be cheaper than buying wrongly — so every ambiguous case resolves to "don't".
 */

// A trigger older than this is not worth acting on. The server ages them out too, but its clock
// and this one can drift and only one of the two is ours to redeploy quickly.
const MAX_TRIGGER_AGE_MS = 90000;

/**
 * Should this trigger buy this armed item?
 *
 * @param {object} trigger  from the monitor: { asin, offerId, price, sellerVerified, at }
 * @param {object} armed    the user's row: { asin, quantity, maxPrice, allowUnverifiedSeller }
 * @param {object} opts     { now, armedGlobally }
 * @returns {{buy: boolean, reason: string}}
 */
function decide(trigger, armed, opts = {}) {
  const now = opts.now || Date.now();

  // The kill switch outranks everything, including a perfectly good trigger. It is the control a
  // human reaches for when something is visibly going wrong, so nothing may override it.
  if (opts.armedGlobally === false) return { buy: false, reason: 'disarmed' };

  if (!trigger || typeof trigger !== 'object') return { buy: false, reason: 'no trigger' };
  if (!armed || typeof armed !== 'object') return { buy: false, reason: 'not armed' };

  const tAsin = String(trigger.asin || '').trim().toUpperCase();
  const aAsin = String(armed.asin || '').trim().toUpperCase();
  if (!tAsin || !aAsin) return { buy: false, reason: 'missing asin' };
  if (tAsin !== aAsin) return { buy: false, reason: 'asin mismatch' };

  // Stale trigger. The offer that fired it is gone and the buy box has moved on; acting now is
  // how someone gets a surprise charge for something they stopped watching an hour ago.
  // A trigger with no usable timestamp is refused outright, NOT waved through. Treating an
  // unreadable `at` as "not stale" removes the only thing standing between the server's whole
  // replay buffer and the card: re-arm after a week, ask from an old cursor, and every buffered
  // trigger would buy at once.
  const at = Number(trigger.at);
  if (!Number.isFinite(at) || at <= 0) return { buy: false, reason: 'trigger has no usable timestamp' };
  if (now - at > MAX_TRIGGER_AGE_MS) {
    return { buy: false, reason: `stale (${Math.round((now - at) / 1000)}s)` };
  }

  // An unconfirmed seller. The ALERT path deliberately fails open here — that was a client
  // decision after a stale verdict silenced a real restock — but sending a message and spending
  // money are different risks, so this defaults to refusing and must be opted out of per item.
  if (trigger.sellerVerified !== true && armed.allowUnverifiedSeller !== true) {
    return { buy: false, reason: 'seller not verified' };
  }

  // Max price. Required, not optional: an armed row without a ceiling is an open chequebook, and
  // the one thing a scalper can do to a watched ASIN is relist it at four times the price.
  const max = Number(armed.maxPrice);
  if (!Number.isFinite(max) || max <= 0) return { buy: false, reason: 'no max price set' };

  const price = Number(trigger.price);
  // No price is NOT permission to buy. A missing price means we never read one, which is exactly
  // when a ceiling matters most.
  if (!Number.isFinite(price) || price <= 0) return { buy: false, reason: 'no price on trigger' };
  if (price > max) return { buy: false, reason: `price $${price} over max $${max}` };

  return { buy: true, reason: 'ok' };
}

/**
 * The checkout URL, pinned to the offer the alert fired on.
 *
 * `offeringID` is the whole point. Without it Amazon sells whatever is in the buy box when the
 * page loads, which may be a different seller at a different price than the one that passed the
 * guards above — the same defect the Discord ATC links had.
 */
function buyNowUrl(asin, offerId, quantity) {
  const a = encodeURIComponent(String(asin).trim());
  const q = clampQuantity(quantity);
  const raw = String(offerId || '').trim();

  // NO OFFER ID => NO DIRECT BUY NOW. Returning a bare entry URL here would let Amazon pick
  // whatever is in the buy box, which is the precise failure this parameter exists to prevent.
  // The caller falls back to the product page instead. (PokeACO refuses the same way:
  // "Amazon direct Buy Now entry requires a live offering ID.")
  if (!raw) return null;

  // THE TOKEN MUST REACH AMAZON PERCENT-ENCODED, AND IT CAN ARRIVE HERE EITHER WAY.
  //
  // An OLID is base64 and carries `+`, `/` and `=`. Put raw into a query string, `+` decodes to a
  // SPACE and Amazon resolves nothing — then falls back to the buy box, which is the exact defect
  // this parameter exists to prevent.
  //
  // PokeACO sends its token raw, and that is correct FOR THEM: their users paste it out of a
  // Discord alert, and monitors publish it already encoded — verified against a live Zephyr /
  // PokeNotify alert whose Offer Id field reads `N%2B3cj…%2F9tbU…%3D`. Our feed is different: it
  // carries the raw OLID straight from the adapter. So detect which we were handed rather than
  // assuming, because double-encoding (`%2B` -> `%252B`) breaks it just as thoroughly.
  //
  // No trailing `=` is appended. That padding survives encoding as `%3D`; PokeACO re-adds it
  // because a pasted value may have lost it, and doing the same to an intact token yields `=%3D`.
  const looksEncoded = /%[0-9A-Fa-f]{2}/.test(raw);
  const offering = looksEncoded ? raw : encodeURIComponent(raw);
  return `https://www.amazon.ca/checkout/entry/buynow?asin=${a}&offeringID=${offering}&quantity=${q}`;
}

/** The product page, for when there is no offer id to pin. */
function productUrl(asin) {
  return `https://www.amazon.ca/dp/${encodeURIComponent(String(asin).trim())}`;
}

// The only page where Amazon states what it is about to sell. Reading identity anywhere earlier
// reads our own query string back to ourselves.
const RE_SPC = /^\/checkout\/p\/[^/]+\/spc$/;
const RE_ITEMSELECT = /^\/checkout\/p\/[^/]+\/itemselect$/;
const RE_THANKYOU = /^\/checkout\/p\/[^/]+\/thankyou(?:\/|$)/;

function pageStateOf(url) {
  let p;
  try { p = new URL(String(url)).pathname; } catch { return 'unknown'; }
  if (p.startsWith('/ap/signin')) return 'signin';
  if (p === '/checkout/entry/oos') return 'out_of_stock';
  if (p.startsWith('/checkout/entry/cart')) return 'cart';
  if (p.startsWith('/checkout/entry/buynow')) return 'entry';   // transient redirector
  if (RE_SPC.test(p)) return 'spc';
  if (RE_ITEMSELECT.test(p)) return 'itemselect';
  if (p.startsWith('/gp/buy/thankyou/') || RE_THANKYOU.test(p)) return 'thankyou';
  if (p.startsWith('/gp/product/')) return 'product';
  if (/^\/dp\/[A-Z0-9]{10}/i.test(p)) return 'product';
  return 'unknown';
}

/** Amazon's "your quantity was reduced" page rewrites to the real checkout. */
function itemSelectToSpc(url) {
  try {
    const u = new URL(String(url));
    if (!RE_ITEMSELECT.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(/\/itemselect$/, '/spc');
    u.search = '?referrer=spc';
    return u.href;
  } catch { return null; }
}

/**
 * Quantity is clamped, never trusted.
 *
 * Amazon's own limit is 12 on these listings, and a bad config or a fat-fingered "100" must not
 * become a hundred booster boxes. One is the floor because zero would submit an empty order.
 */
function clampQuantity(q) {
  const n = Math.floor(Number(q));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(12, n);
}

/**
 * Is the page we landed on actually the product we intended to buy?
 *
 * Checked on the checkout page itself, after navigation, because everything up to this point is
 * trust in the monitor and in Amazon's routing. This is the last moment a mistake is free.
 *
 * @param {object} page  { asin, lineItemCount, price }
 * @param {object} intent { asin, maxPrice }
 */
function verifyCheckoutPage(page, intent) {
  if (!page || !intent) return { ok: false, reason: 'nothing to verify' };

  const pAsin = String(page.asin || '').trim().toUpperCase();
  const iAsin = String(intent.asin || '').trim().toUpperCase();
  // An unreadable ASIN is inconclusive, and inconclusive means don't buy. This is the opposite
  // of the monitor's rule for ALERTS, where inconclusive means send — because the costs invert.
  if (!pAsin) return { ok: false, reason: 'could not read ASIN on checkout page' };
  if (pAsin !== iAsin) return { ok: false, reason: `checkout shows ${pAsin}, expected ${iAsin}` };

  // More than one line item means we are looking at the cart, not an isolated Buy Now. Placing
  // that order buys everything the user happened to have in their basket.
  //
  // An UNREADABLE count is refused too. Returning 1 when the selectors matched nothing — which an
  // earlier draft did — means the guard passes on exactly the pages it failed to understand.
  const lines = Number(page.lineItemCount);
  if (!Number.isFinite(lines) || lines < 1) return { ok: false, reason: 'could not read the checkout line items' };
  if (lines > 1) {
    return { ok: false, reason: `checkout holds ${lines} line items — refusing to buy a cart` };
  }

  /**
   * The price ceiling, against the order total.
   *
   * `maxPrice` is PER UNIT, so the comparison has to allow for quantity, tax and shipping or a
   * correctly-armed item would be refused for ever: $54.99 with a $59.99 ceiling becomes a $62.14
   * total after 13% HST, and a naive comparison rejects it every time. Users who work that out by
   * doubling their ceiling have then disabled the trigger-level check, which is the one that stops
   * a scalper relist.
   *
   * An UNREADABLE total does not silently pass. It is allowed only when the buy is pinned to a
   * specific offer — the offering id fixes which offer Amazon sells, and `decide()` has already
   * held that offer's price against the ceiling. Without a pinned offer there is nothing
   * determining what is being charged, so it refuses.
   */
  const max = Number(intent.maxPrice);
  const price = Number(page.price);
  if (Number.isFinite(max)) {
    // `price > 0`, not just finite: Number(null) is 0, which is finite and would take this
    // branch and then compare 0 against the ceiling — passing every unreadable page.
    if (Number.isFinite(price) && price > 0) {
      const qty = Math.max(1, Number(intent.quantity) || 1);
      const allowance = Number.isFinite(intent.taxAllowance) ? intent.taxAllowance : 0.20;
      const ceiling = max * qty * (1 + allowance) + (Number(intent.shippingAllowance) || 15);
      if (price > ceiling) {
        return { ok: false, reason: `checkout total $${price} over $${ceiling.toFixed(2)} (max $${max} x${qty} + tax)` };
      }
    } else if (!intent.offerPinned) {
      return { ok: false, reason: 'could not read the checkout total and the offer is not pinned' };
    }
  }

  return { ok: true, reason: 'ok' };
}

/**
 * Did Amazon put a challenge in front of us?
 *
 * Detected and handed to the human, never solved. PokeACO draws the same line and it is the
 * right one — an automated answer to "prove you are not a robot" is a different kind of tool.
 */
function looksChallenged(url, bodyText) {
  const u = String(url || '');
  if (/\/errors\/validateCaptcha|\/ap\/signin/.test(u)) return true;
  const t = String(bodyText || '');
  if (t.length > 60000) return false; // a real page; markers below appear on good pages too
  return /Enter the characters you see below|not a robot|Sorry, we just need to make sure/i.test(t);
}

/** Amazon's own "this offer is gone" landing page. */
function isOutOfStockUrl(url) {
  return /\/checkout\/entry\/oos/.test(String(url || ''));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    decide, buyNowUrl, productUrl, clampQuantity, verifyCheckoutPage,
    looksChallenged, isOutOfStockUrl, pageStateOf, itemSelectToSpc,
    MAX_TRIGGER_AGE_MS,
  };
}
