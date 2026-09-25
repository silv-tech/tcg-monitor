/**
 * Parse the buy-box slice the Amazon browser bridge sends back.
 *
 * The bridge (amazon-extension/) reads an amazon.ca /dp/ page in the client's own Canadian
 * Chrome and posts back a few KB of extracted elements rather than the 400KB-1.5MB page. This
 * module turns that slice into the SAME shape `_offersToData` produces from the paid
 * structured/offers call:
 *
 *     { name, price, inStock, pricePinned, seller }
 *
 * One shape on purpose. Both readers then flow through one apply path in the adapter, so a
 * browser read and a paid read cannot drift into disagreeing about what "in stock" means.
 *
 * WHY THE BRIDGE IS WORTH A PARSER AT ALL. On a /dp/ page the buy box IS the pinned offer — it
 * is the offer Amazon itself featured — so a price read here is authoritative by construction.
 * That matters because most Amazon price paths are NOT scoped to the buy box: the search tile
 * shows whatever offer Amazon features and `_parseAod` takes the first price anywhere in the
 * fragment. One of those wrote $229.00 into B0H78BB9TY (real price $89.99), it survived
 * indefinitely because an out-of-stock read carries the cached price forward, and the monitor
 * later published a -61% "price drop" that never happened. See tcg-amazon-price-provenance.
 */

const cheerio = require('cheerio');

/**
 * Amazon says "unavailable" in words, in several places, and a page can carry a stale price
 * alongside any of them. Each of these is decisive on its own.
 */
const UNAVAILABLE = /currently unavailable|we don't know when or if this item will be back|temporarily out of stock|non disponible actuellement/i;

/**
 * Prices on amazon.ca render as "$86.03", "CDN$ 86.03" or "CDN$86.03" — and, in the French
 * storefront, "86,03 $". Parse all of them, and refuse anything that is not a plain number, so a
 * range ("from $40") or a per-unit blurb cannot become a price.
 */
function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s|CDN|CAD|\$/gi, '');
  // Comma as decimal separator (fr-CA) only when it is followed by exactly two digits at the end.
  const normalized = /,\d{2}$/.test(cleaned) ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Who is selling the pinned offer.
 *
 * This is the free answer to the "sold by Amazon only" gate, which currently costs a paid offers
 * call to reach. Returned verbatim rather than reduced to a boolean: the gate's own rule about
 * what counts as Amazon lives with the gate, and a raw seller string keeps this parser out of
 * that decision.
 */
function sellerFromPhrase(text) {
  if (!text) return null;
  const sold = String(text).match(/sold by\s+(.+)$/i);
  if (!sold) return null;
  // Cut the trailing clause, NOT at the first ".". "Amazon.ca" contains one, and cutting there
  // reported the seller as "Amazon" — a different merchant from Amazon.ca, and exactly the wrong
  // name to hand the "sold by Amazon only" gate.
  const name = sold[1]
    .split(/\s+and\s+(?:fulfilled|shipped|ships)\b/i)[0]
    .replace(/\.\s*$/, '')
    .trim();
  return name || null;
}

function parseSeller($) {
  const trigger = $('#sellerProfileTriggerId').first().text().replace(/\s+/g, ' ').trim();
  if (trigger) return trigger;

  // The newer buy-box layout puts the merchant in its own feature row rather than #merchant-info.
  const feature = $('#offer-display-features')
    .find('[offer-display-feature-name="desktop-merchant-info"]').first()
    .text().replace(/\s+/g, ' ').trim();
  if (feature) return sellerFromPhrase(feature) || feature;

  const merchant = $('#merchant-info').first().text().replace(/\s+/g, ' ').trim();
  if (!merchant) return null;
  // "Ships from and sold by Amazon.ca." / "Sold by X and Fulfilled by Amazon."
  return sellerFromPhrase(merchant) || merchant.slice(0, 80) || null;
}

/**
 * @param {string} slice  concatenated outerHTML of the elements page.js extracted
 * @returns {{name:string, price:number|null, inStock:boolean, pricePinned:boolean, seller:string|null}|null}
 *          null when the slice carries no product title — a read without one is INCONCLUSIVE,
 *          never out of stock. That distinction is load-bearing: the verdict contract lets
 *          `no-stock` send and only `wrong-identity` suppress, and a titleless read is neither.
 */
function parseBuyboxSlice(slice) {
  if (!slice || typeof slice !== 'string') return null;
  const $ = cheerio.load(slice);

  const name = $('#productTitle').first().text().replace(/\s+/g, ' ').trim();
  if (!name) return null;

  // The buy-box price, and ONLY the buy-box price. `#corePrice_feature_div` and `#apex_desktop`
  // are the pinned offer's own blocks; a price found anywhere else on a product page belongs to
  // some other offer (used, other sellers, a bundle) and is exactly the unscoped kind that
  // poisoned B0H78BB9TY.
  let price = null;
  for (const sel of ['#corePrice_feature_div', '#corePriceDisplay_desktop_feature_div', '#apex_desktop']) {
    const block = $(sel).first();
    if (block.length === 0) continue;
    // `.a-offscreen` is the screen-reader copy of the rendered price and is the one node that
    // holds it as a single complete string; the visible price is split across whole/fraction
    // spans that concatenate to "8603".
    const offscreen = block.find('.a-offscreen').first().text();
    price = parsePrice(offscreen);
    if (price != null) break;
  }

  const availabilityText = $('#availability').first().text().replace(/\s+/g, ' ').trim();
  const unavailable = $('#outOfStock').length > 0 || UNAVAILABLE.test(availabilityText);
  const canBuy = $('#add-to-cart-button').length > 0 || $('#buy-now-button').length > 0;

  // STOCK = the pinned offer has a numeric price, exactly as `_offersToData` defines it, with the
  // page's own explicit unavailability allowed to veto. The veto is not redundant: Amazon keeps
  // rendering a price block on some unavailable listings, so price alone would call them in stock.
  //
  // A missing add-to-cart button is deliberately NOT a veto on its own. The bridge fetches the
  // page rather than rendering it, and that control is one of the parts Amazon assembles
  // client-side, so its absence is frequently a property of how we read rather than of the offer.
  const inStock = price != null && !unavailable;

  return {
    name,
    price,
    inStock,
    // On a /dp/ page the buy box IS the pinned offer, so a price from those blocks is
    // authoritative — the one thing the free search path can never claim.
    pricePinned: price != null,
    seller: parseSeller($),
    // Kept for the log line only. Never a verdict input: see the note above about why a fetched
    // page legitimately lacks the button.
    _canBuy: canBuy,
  };
}

module.exports = { parseBuyboxSlice, parsePrice, parseSeller, sellerFromPhrase };
