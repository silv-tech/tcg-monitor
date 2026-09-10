/**
 * Verify what an Amazon ASIN is actually selling, from its product page.
 *
 * This replaces the AOD offer endpoint as the per-ASIN check. AOD's free path is blocked (hundreds
 * of 503s, zero reads for hours) and its paid path costs roughly what a product page costs — but a
 * product page also carries the LIVE TITLE, which is the thing AOD could not reliably give us.
 * That matters because Amazon repurposes ASINs: on 2026-09-10 a Discord alert read "Pokémon TCG:
 * Mega Evolution - Phantasmal Flames Booster Bundle" at $196.39 and linked to a $23 PopSockets
 * phone grip. Fifty-five such rows were found and purged in one night.
 *
 * THERE ARE FOUR VERDICTS, and only ONE of them may ever stop an alert.
 *
 *   good            the page parsed, the title is in scope, and there is something to buy
 *   wrong-identity  the page parsed and the thing behind the link is NOT the product we named
 *   no-stock        the page parsed, it IS the right product, and nothing is buyable right now
 *   inconclusive    we did not actually get a page — bot-check, partial body, timeout, no budget
 *
 * A caller must suppress ONLY on `wrong-identity`. Both of the other negatives must still fire:
 *
 *   `inconclusive` is not evidence. Every blocked fetch would otherwise become a suppressed alert,
 *   and a suppressed restock is unrecoverable — poll-adapter writes the new state immediately after
 *   delivery, so events.js can never re-fire it. Silence would look identical to success.
 *
 *   `no-stock` is a TRANSIENT answer to a different question, and on a RESTOCK it is usually just a
 *   race: we detect a drop, re-check ~1.5s later, and a hot item has already sold out. Treating it
 *   as a suppression would silence precisely the fastest-selling items — and pairing it with a
 *   denylist would drop them from tracking for good, losing every future restock as well.
 *
 * The discriminator between "checked" and "couldn't check" is whether a productTitle was extracted.
 * Every real Amazon product page has one; a challenge page or a truncated body does not.
 *
 * `bad` covers two distinct failures, and the second is not something an identity denylist can fix:
 *   - wrong product   — live title fails the shared scope rule
 *   - nothing to buy  — page rendered, but no buy box and no offer id. B0C75FSW7C was stored
 *                       inStock:true with exactly this shape: no add-to-cart, no availability
 *                       block, no offer. Search said buyable; nothing had contradicted it since the
 *                       free stock check died.
 */

const { isInScopeName } = require('./scope');

/** Amazon renders the price in several places; the offscreen span is the reliable one. */
const PRICE = [
  /class="a-offscreen">\s*\$?([\d,]+\.\d{2})\s*</,
  /id="priceblock_ourprice"[^>]*>\s*\$?([\d,]+\.\d{2})/,
  /class="a-price-whole">\s*([\d,]+)/,
];

/**
 * The offer listing id, which the alert embed's one-click add-to-cart links are built from.
 * Measured on live pages: `offerListingID` was present on every buyable listing tested,
 * `offeringID.1` on most, and the buy-box JSON on most. Ordered by observed reliability.
 */
const OLID = [
  /name="offerListingID"[^>]*value="([^"]{10,})"/,
  /name="offeringID\.1"[^>]*value="([^"]{10,})"/,
  /"offerListingId"\s*:\s*"([^"]{10,})"/,
];

const SELLER = [
  /id="sellerProfileTriggerId"[^>]*>([^<]{2,60})</,
  /Sold by[\s\S]{0,120}?>([^<]{2,60})</i,
  /Ships from[\s\S]{0,120}?>([^<]{2,60})</i,
];

function first(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the fields we care about out of a product page.
 *
 * `parsed` is the honesty flag: false means this was not a product page we can reason about, and
 * the caller must not conclude anything from the absence of a buy box.
 */
function parseListing(html) {
  const out = {
    parsed: false, title: null, price: null, inStock: false, seller: null, olid: null,
  };
  if (!html || typeof html !== 'string' || html.length < 500) return out;

  const title = decode(first(html, [/id="productTitle"[^>]*>([^<]{5,300})</]));
  if (!title) return out;                 // no title => not a page we actually read
  out.parsed = true;
  out.title = title;

  const priceStr = first(html, PRICE);
  const price = priceStr ? Number(String(priceStr).replace(/,/g, '')) : NaN;
  out.price = Number.isFinite(price) && price > 0 ? price : null;

  out.olid = first(html, OLID);
  out.seller = decode(first(html, SELLER)) || null;

  // Amazon states availability in words, and that is the most reliable signal on the page — more
  // so than the cart control, whose id and attribute order vary by layout. Measured on real pages:
  // a buyable listing rendered `id="availability" ... > In Stock <` while carrying an
  // `offeringID.1` input with NO value attribute at all, so an offer-id-only rule called a
  // genuinely in-stock product unbuyable.
  const availability = (html.match(/id="availability"[\s\S]{0,600}?(?:<\/div>|$)/) || [''])[0];
  const saysInStock = /\bin stock\b|only \d+ left in stock|usually ships within/i.test(availability);
  const explicitlyOut = /currently unavailable|temporarily out of stock|out of stock|we don't know when or if this item/i
    .test(availability || html);
  const hasCart = /id="add-to-cart-button"|name="submit\.add-to-cart"/.test(html);

  // An empty offer id is not an offer. B0C75FSW7C rendered `name="offerListingID" value=""` — the
  // input exists, the offer does not, which is exactly the false in-stock case this check exists
  // to catch. The OLID patterns require 10+ characters for that reason.
  out.inStock = !explicitlyOut && (saysInStock || hasCart || Boolean(out.olid));

  return out;
}

/**
 * Read a structured offers payload (ScraperAPI structured/amazon/offers).
 *
 * This is the cheap lane: ~1 credit and 0.3-2.5KB of JSON, against ~18 credits and 1.2MB for the
 * product page. It also reaches ASINs that search cannot see at all, which is the only way to cover
 * the hand-picked watchlist items.
 *
 * STOCK IS THE PINNED OFFER'S PRICE, NOT "any listing has a price".
 *
 * `pinned_offer: true` marks the featured offer — the buy box. Marketplace listings sit alongside
 * it and carry prices whether or not anything is actually featured. Measured on real payloads:
 *
 *   B0FPLGBRCT  pinned price 86.03                          -> buy box, buyable
 *   B0C75FSW7C  pinned NO price, 4 other listings priced    -> no buy box
 *   B0H77W4411  pinned NO price, no other listings          -> no buy box
 *
 * B0C75FSW7C is the case that matters: an "any listing with a price" rule calls it in stock, and it
 * is already our known false-in-stock row whose product page shows no add-to-cart at all. That rule
 * would have confirmed the bug instead of catching it. The pinned-offer rule agrees with the
 * product page on all three.
 *
 * There is NO offer-listing id anywhere in this payload — checked the whole tree across three
 * ASINs. The alert embed's one-click links need that from elsewhere.
 */
function parseOffers(payload) {
  const out = {
    parsed: false, title: null, price: null, inStock: false, seller: null, olid: null,
  };

  let j = payload;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch { return out; }
  }
  if (!j || typeof j !== 'object') return out;

  const name = j.item && typeof j.item.name === 'string' ? j.item.name.trim() : '';
  if (!name) return out;          // no item.name => not a payload we can reason about
  out.parsed = true;
  out.title = decode(name);

  const listings = Array.isArray(j.listings) ? j.listings : [];
  const priced = (l) => l && typeof l.price === 'number' && Number.isFinite(l.price) && l.price > 0;

  // The featured offer. Fall back to the first listing only when nothing is flagged pinned, so a
  // payload shape change degrades to "read the top offer" rather than to "in stock".
  const pinned = listings.find((l) => l && l.pinned_offer) || listings[0] || null;

  if (pinned && priced(pinned)) {
    out.inStock = true;
    out.price = pinned.price;
    out.seller = pinned.seller_name ? decode(pinned.seller_name) : null;
  } else {
    // Nothing featured. Still report the cheapest real offer as context for the log line — but the
    // product is NOT reported buyable, because a buyer following the link finds no buy box.
    const cheapest = listings.filter(priced).sort((a, b) => a.price - b.price)[0] || null;
    if (cheapest) {
      out.price = cheapest.price;
      out.seller = cheapest.seller_name ? decode(cheapest.seller_name) : null;
    }
  }

  return out;
}

/**
 * Check one ASIN.
 *
 * The fetcher is injected, which is what keeps every spend decision on the caller's side: when a
 * budget cap is reached the caller passes a fetcher that returns null, and this yields
 * `inconclusive` without a request being made. Never throws — a throw is `inconclusive`, because a
 * crash must not be able to look like a definitive negative.
 *
 * @param {string} asin
 * @param {{fetcher:(url:string)=>Promise<string|null>, timeoutMs?:number}} opts
 * @returns {Promise<{verdict:'good'|'wrong-identity'|'no-stock'|'inconclusive', reason:string,
 *   title?:string, price?:number, inStock?:boolean, seller?:string, olid?:string}>}
 */
async function verifyAmazonListing(asin, opts = {}) {
  const { fetcher, timeoutMs = 4000 } = opts;
  if (!asin || typeof fetcher !== 'function') {
    return { verdict: 'inconclusive', reason: 'no fetcher' };
  }

  let html = null;
  try {
    let timer;
    html = await Promise.race([
      fetcher(`https://www.amazon.ca/dp/${asin}`),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  } catch {
    return { verdict: 'inconclusive', reason: 'fetch threw' };
  }

  // The caller owns the fetcher, so it decides which lane we are on: the cheap structured offers
  // endpoint (JSON, ~1 credit) or a product page (HTML, ~18 credits, and the only source of an
  // offer listing id). Route on the shape of what came back rather than making the caller declare
  // it — that way the same seam serves both without a second signature.
  const looksJson = typeof html === 'string' && /^\s*[{[]/.test(html);
  const p = (looksJson || (html && typeof html === 'object')) ? parseOffers(html) : parseListing(html);

  if (!p.parsed) {
    // A WAF challenge served with HTTP 200, a partial body, a 5xx, a timeout, or a fetch the budget
    // refused. Every one of those looks like silence, and silence must never suppress an alert.
    return { verdict: 'inconclusive', reason: 'no product identity in response' };
  }

  const fields = {
    title: p.title, price: p.price, inStock: p.inStock, seller: p.seller, olid: p.olid,
  };

  // These two were briefly one verdict ('bad'), and that was a latent catastrophe. They answer
  // completely different questions and a caller must not be able to conflate them:
  //
  //   wrong-identity  the thing behind this link is NOT the product we named. Permanent, and a
  //                   property of the listing. Safe to suppress and to denylist.
  //   no-stock        it IS the right product, and right now nothing is buyable. TRANSIENT, and
  //                   for a RESTOCK it is very often just a race — we detect a drop, re-check
  //                   ~1.5s later, and a hot item has already sold out. Suppressing on this would
  //                   silence exactly the fastest-selling items, and denylisting on it would drop
  //                   them from tracking permanently, losing every future restock too.
  //
  // Distinguishing them by verdict rather than by matching the reason string is deliberate: a
  // reworded reason must not be able to silently re-introduce that behaviour.
  if (!isInScopeName(p.title)) {
    return { verdict: 'wrong-identity', reason: `live title is out of scope: "${p.title.slice(0, 80)}"`, ...fields };
  }
  if (!p.inStock) {
    return { verdict: 'no-stock', reason: 'page has no buy box and no offer — nothing to buy', ...fields };
  }
  return { verdict: 'good', reason: 'title in scope and a live offer exists', ...fields };
}

module.exports = { verifyAmazonListing, parseListing, parseOffers };
