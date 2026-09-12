/**
 * Is this ASIN sold by Amazon itself?
 *
 * ONE rule, in ONE place, because the client's filter is "sold by Amazon only" and this project
 * has already been bitten by the same rule existing twice: `deliver()` and `routeEvent()` carried
 * different out-of-stock exemption lists, and every EARLY_SKU alert died in the gap.
 *
 * WHY NOT `seller.toLowerCase().includes('amazon')`
 * -------------------------------------------------
 * That is what delivery.js used, and it is wrong in the expensive direction: a marketplace seller
 * called "SuperAmazonDeals", "TheAmazonStore" or "Amazonia Trading" reads as Amazon and its
 * listing is PUBLISHED to the client's paid channel. That is the exact complaint this was written
 * to answer — B0FP9ZZ68C, "Ships from Amazon / Sold by Brick Arsenal LLC", reached the client.
 *
 * So the match is anchored: the name must BE an Amazon storefront, not merely contain the word.
 * "Amazon", "Amazon.ca", "Amazon.com" pass; "Amazonia Trading" does not, because what follows
 * "amazon" is a letter rather than a dot or the end of the string.
 *
 * FULFILMENT IS NOT SELLERSHIP. "Ships from Amazon" is Amazon warehousing someone else's stock
 * (FBA) and says nothing about who is selling. B0FP9ZZ68C ships from Amazon and is sold by Brick
 * Arsenal LLC. Only the SOLD BY value may ever be passed to this function.
 */

// The name must BEGIN with the standalone word "amazon" — followed by end-of-string, a dot (a
// domain suffix: Amazon.ca), or a space (an Amazon-owned storefront: "Amazon Warehouse").
//
// Requiring only `^amazon\.?$` was the first draft, and it is wrong in the EXPENSIVE direction:
// "Amazon Warehouse" is Amazon, and suppressing it recreates the lost-restock failure. Meanwhile
// the leading anchor is what keeps impostors out — "Amazonia Trading" fails because what follows
// "amazon" is a letter, and "SuperAmazonDeals" fails because it does not start with the word.
//
// Only 20 of 630 cached verdicts carry an Amazon name today and all read "Amazon.ca", but that
// sample comes from the AOD regex, which structurally never returns Amazon (it needs an
// <a role="link"> that only marketplace sellers render). The authoritative source is now the
// offers API's seller_name, whose exact wording for Amazon-sold items is UNOBSERVED — so the
// rule keys on the shape Amazon storefronts share rather than on a list of guessed literals.
//
// Deliberately NOT matching "vendu et expédié par X" — that is a PHRASE containing a seller name,
// not a seller name, and treating it as one made every French-locale scalper read as Amazon.
const AMAZON_STOREFRONT = /^amazon(?:[\s.]|$)/i;

/**
 * @param {string|null|undefined} seller  the SOLD BY name, never a fulfilment or shipping value
 * @returns {boolean} true only when Amazon itself is the seller
 */
function isSoldByAmazon(seller) {
  if (seller == null) return false;
  const name = String(seller).trim();
  if (!name) return false;
  return AMAZON_STOREFRONT.test(name);
}

/**
 * Should this seller verdict suppress the alert?
 *
 * Split out from isSoldByAmazon because the two questions differ on ONE input that matters:
 * a missing verdict. Unknown is not third-party — the gate fails OPEN on it by the client's
 * explicit instruction, after a stale verdict silenced a real restock (B0H7FDBNSB, 2026-09-12).
 * Writing this as `!isSoldByAmazon(seller)` would suppress every alert whose seller could not be
 * read, which is the opposite of what the client asked for.
 */
function isThirdPartySeller(seller) {
  if (seller == null || String(seller).trim() === '') return false;   // unknown -> do not suppress
  return !isSoldByAmazon(seller);
}

module.exports = { isSoldByAmazon, isThirdPartySeller };
