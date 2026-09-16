/**
 * Pokemon Center products read from __NEXT_DATA__, in a module with NO dependencies.
 *
 * Dependency-free for the same reason as pokemoncenter-verdict.js: scripts/pc-grid-probe.js must
 * be able to use the one real copy of these rules without loading src/config, which calls
 * process.exit(1) in production when admin auth is unset.
 *
 * WHERE THIS CAME FROM. Probe 3 on the live store (2026-09-15, one load of trading-card-game,
 * Railway residential exit) found the grid's products inside the document, at
 *
 *   $.props.initialState.search.results.products[]
 *
 * with 31 entries against 31 rendered grid tiles. Probe 1 had already established the negative
 * that matters here: NO XHR fills the grid, so this is not an API that can be called on its own.
 * It is the same document the DOM sweep already loads. Reading it costs no extra request and
 * saves none either -- the win is the shape of the data, not the number of page loads.
 *
 * A product object, captured verbatim from that run:
 *
 *   { brand, code: "10-10320-101", name, outOfStock: false, prf: "P11645",
 *     listPrice: { amount: 53.99, display: "$53.99" },
 *     purchasePrice: { amount: 53.99, display: "$53.99" },
 *     images: [{ original, thumbnail, high }], releaseDate: "2026-07-08T00:00:00Z",
 *     reportingCrumb: "TRADING CARD GAME>TCG Accessories>Binders", ... }
 *
 * WHY IT BEATS THE TILES. The DOM extractor matches `a[href*="/en-ca/product/"]`, and the
 * mega-menu carries its own product links, so it cannot tell a grid tile from a nav item. That
 * same run returned 33 anchors for 31 products: the two extras, 716E11935 and 715E10557, do not
 * even share the grid's SKU format and were the two tiles the verdict had to refuse. This array
 * is the grid and nothing else.
 *
 * ONLY EVER VALID FOR THE DOCUMENT AS LOADED. __NEXT_DATA__ is the server-rendered payload of the
 * navigation that fetched it, and a client-side route change does NOT rewrite that script tag.
 * Probe 4 proved this the hard way: driving the "Items per page" control to 96 moved the URL to
 * ?page=1&ps=96 without a navigation, and the parser still returned the 32 sold-out products from
 * ?page=8. Worse, that in-app transition is what the site defends — it fired
 * GET /tpci-ecommweb-api/search?...&fl=availability_status,... which returned 403, and DataDome
 * served a captcha naming that search URL as its referer, while both plain full-document
 * navigations rendered cleanly.
 *
 * So the caller must do a full page.goto() per page and read this immediately afterwards. Never
 * interact with the pager, the sort or the page-size control to move between pages.
 */

/** The one path Probe 3 measured. Kept as data so a shape change reads as a shape change. */
const PRODUCTS_PATH = ['props', 'initialState', 'search', 'results', 'products'];

function dig(root, path) {
  let node = root;
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Price a shopper would pay, preferring purchasePrice over listPrice.
 *
 * Both were identical across every product in the probe run, but they are separate fields and a
 * sale is exactly when they diverge -- purchasePrice is the one on the button.
 */
function amountOf(node) {
  if (!node) return null;
  const raw = node.amount;
  // A numeric string is the most likely benign drift in a payload like this, and silently
  // dropping the price for it would be worse than reading it.
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The price a shopper would pay.
 *
 * purchasePrice beats listPrice: they were identical on every product measured, but they are
 * separate fields and a sale is exactly when they diverge -- purchasePrice is the one on the
 * button.
 *
 * The *PriceRange fields are the fallback, and they matter more than they look. This store sells
 * sized product -- readOffers() elsewhere in the adapter exists precisely because a Crocs clog
 * ships as nine variants under one page -- and for those the flat price can be absent while the
 * range carries it. `fromPrice` is taken for the same reason readOffers takes lowPrice: it is the
 * number the grid displays and the one a shopper sees first.
 */
function pickPrice(p) {
  if (!p) return null;
  for (const key of ['purchasePrice', 'listPrice']) {
    const amount = amountOf(p[key]);
    if (amount != null) return amount;
  }
  for (const key of ['purchasePriceRange', 'listPriceRange']) {
    const amount = amountOf(p[key] && p[key].fromPrice);
    if (amount != null) return amount;
  }
  return null;
}

/**
 * The stock verdict for one JSON product.
 *
 * `outOfStock` is a boolean on every product the probe saw, so it is read strictly: only a real
 * boolean answers, and anything else refuses. This is the same rule pcVerdict() applies to tile
 * text and it points the same way deliberately -- see the safety note there. Guessing "in stock"
 * from the mere absence of the field would manufacture a restock wave into a paid channel the
 * first time the site renamed it.
 *
 * CONFIRMED IN BOTH DIRECTIONS (Probe 4, 2026-09-16, one load of trading-card-game ?page=8):
 *
 *   page 1   JSON 31 products, 31 in stock,  0 unreadable   DOM 33 anchors, 31 in stock, 2 unreadable
 *   page 8   JSON 32 products, 32 sold out,  0 unreadable   DOM 34 anchors, 32 sold out, 2 unreadable
 *
 * 63 products, full agreement with the tile verdict on every one, and zero unreadable rows on
 * the JSON side both times against two on the DOM side. A sold-out product keeps its price
 * (`outOfStock: true` alongside `purchasePrice.amount: 20.99` on 699-17157), exactly mirroring
 * the tile rule that the badge is the stock signal and the price is not.
 */
function pcStockFromJson(p) {
  if (p && typeof p.outOfStock === 'boolean') return !p.outOfStock;
  return null;
}

/**
 * Every product in a category page's __NEXT_DATA__.
 *
 * @param {string|object} nextData  the __NEXT_DATA__ script contents, raw text or already parsed
 * @returns {{products: Array<{sku,name,price,inStock,image,releaseDate,breadcrumb}>, dropped:number}|null}
 *          null when the products array is not where it was measured, OR when it had rows and
 *          none of them survived parsing. `dropped` counts rows discarded for want of a usable
 *          sku, so a PARTIAL shape change is visible in the caller's log instead of quietly
 *          shrinking the catalogue.
 *
 * NULL IS NOT AN EMPTY CATALOGUE. A missing array means the page shape changed, the document was
 * a block page, or hydration never ran. Returning [] for that would tell the caller the category
 * is empty, and an empty category reads as every product in it going out of stock at once. This
 * store has already produced exactly that failure once from the other direction: with Bright
 * Data's account suspended, 188 dead checks marked all 805 products out of stock while health
 * still reported green. The caller must be able to tell "nothing there" from "could not look".
 */
function pcProductsFromNextData(nextData) {
  let root = nextData;
  if (typeof root === 'string') {
    try { root = JSON.parse(root); } catch { return null; }
  }
  const raw = dig(root, PRODUCTS_PATH);
  if (!Array.isArray(raw)) return null;

  const bySku = new Map();
  let dropped = 0;
  for (const p of raw) {
    if (!p || typeof p !== 'object') { dropped += 1; continue; }
    const sku = typeof p.code === 'string' ? p.code.trim() : '';
    if (!sku) { dropped += 1; continue; }     // a row with no SKU cannot be matched to anything
    const image = (Array.isArray(p.images) && p.images[0] && typeof p.images[0].original === 'string')
      ? p.images[0].original : '';
    const row = {
      sku,
      name: typeof p.name === 'string' ? p.name : '',
      price: pickPrice(p),
      inStock: pcStockFromJson(p),
      image,
      releaseDate: typeof p.releaseDate === 'string' ? p.releaseDate : null,
      breadcrumb: typeof p.reportingCrumb === 'string' ? p.reportingCrumb : '',
    };

    // The same sku twice is the array's problem, not a verdict. Keeping the last silently picked
    // a winner and made the cross-check report a disagreement between the JSON and the tile that
    // did not exist. Collapse instead, and when the copies CONTRADICT each other on stock, refuse
    // -- the same rule the rest of this module applies to anything it cannot read cleanly.
    const seen = bySku.get(sku);
    if (!seen) { bySku.set(sku, row); continue; }
    if (seen.inStock !== row.inStock) seen.inStock = null;
    if (seen.price == null && row.price != null) seen.price = row.price;
    if (!seen.image && row.image) seen.image = row.image;
    if (!seen.name && row.name) seen.name = row.name;
  }

  const products = [...bySku.values()];

  // A ROW-SHAPE CHANGE MUST NOT READ AS AN EMPTY CATALOGUE.
  //
  // The null-vs-[] contract above guards the CONTAINER moving. It said nothing about the rows,
  // and the per-row drop defeated it silently: rename `code`, or ship it as a number, and 96
  // products became `{products: []}` -- the exact value this file promises never to produce for
  // "could not look", and the one that marks a live catalogue dead and then fires the whole
  // restock wave on recovery. An array that had rows and yielded none is a parse failure.
  if (raw.length > 0 && products.length === 0) return null;

  return { products, dropped };
}

module.exports = { pcProductsFromNextData, pcStockFromJson, PRODUCTS_PATH };
