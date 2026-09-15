/**
 * The Pokemon Center stock verdict, in a module with NO dependencies.
 *
 * It lives apart from the adapter so scripts/pc-grid-probe.js can use the one real copy of the
 * rule without loading src/config, which calls process.exit(1) in production when admin auth is
 * unset. A probe service that exits is restarted by Railway and re-hits the site in a loop.
 */

/**
 * The stock verdict for one tile, from the text a shopper actually sees.
 *
 * THE SAFETY RULE, and the reason it points the way it does:
 *
 *   SOLD OUT present            -> false   an explicit statement
 *   a positive price, no badge  -> true    the buyable state on this site
 *   anything else               -> NULL    unreadable; the caller drops it
 *
 * Null is not a third state for storage, it is a refusal to answer. Every stored Pokemon Center
 * row currently reads inStock:false because nothing could ever see stock, so a parser that
 * guessed "in stock" on an unreadable tile would manufacture a restock wave into a paid channel,
 * and one that guessed "out of stock" would mark a live catalogue dead and then fire that wave on
 * recovery. Neither is self-correcting. Silence is.
 *
 * @param {string} text  tile innerText, whitespace-collapsed
 * @returns {{price: number|null, inStock: boolean|null}}
 */
function pcVerdict(text) {
  const t = typeof text === 'string' ? text : '';
  const m = t.match(/\$\s*([\d,]+\.\d{2})/);
  const price = m ? Number(m[1].replace(/,/g, '')) : null;
  const validPrice = Number.isFinite(price) && price > 0 ? price : null;

  // SOLD OUT wins over a price: a sold-out tile still shows what it cost.
  if (/sold\s*out/i.test(t)) return { price: validPrice, inStock: false };
  if (validPrice != null) return { price: validPrice, inStock: true };
  return { price: null, inStock: null };
}

/** Tile name from the URL slug — the grid truncates long titles, the slug does not. */
function pcNameFromSlug(slug) {
  return String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = { pcVerdict, pcNameFromSlug };
