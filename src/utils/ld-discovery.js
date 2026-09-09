/**
 * Finding London Drugs products that are not on London Drugs' website.
 *
 * London Drugs ships TCG product to store shelves without ever publishing it online. Those SKUs
 * are flagged `hidden` in the catalogue: no product page, no category entry, and absent from all
 * 174 sitemaps (29,297 URLs swept 2026-09-09). Nothing the monitor polls can see them, which is
 * how two 30th Celebration items sat in dozens of stores while a competitor alerted on both.
 *
 * There is no listing to read, so discovery walks the product-code space instead. One request
 * classifies a code three ways, and the three are cleanly separable by the message string —
 * HTTP is always 200, and a hidden product and a nonexistent code are both 175 bytes, so length
 * alone decides nothing:
 *
 *   VISIBLE      {"isSuccess":true,...,"productName":"..."}
 *   HIDDEN       {"isSuccess":false,...,"message":"Item not found: L3445571 ... is hidden"}
 *   NONEXISTENT  {"isSuccess":false,...,"message":"Item not found: L9999999 ... not found"}
 *
 * A hidden code exposes NO name through any endpoint (/details /summary /price /seo /images
 * /media /fulfillment and ?includeHidden=true were all checked). Only stock and a box-art image.
 * So a hidden code cannot be identified by text — and identity matters, because hidden codes are
 * not all Pokemon: of seven found in one window, one was a NETGEAR network switch and one was a
 * bag of Peeps marshmallows.
 *
 * What separates them is the SHAPE OF THE STOCK, not the name. A national TCG allocation lands in
 * dozens of stores in case quantities; incidental hidden stock does not. Measured across all 78
 * stores on 2026-09-09:
 *
 *   L3445566  NETGEAR switch          1 store,    1 unit    <- junk
 *   L3445590  Peeps marshmallows     11 stores,  13 units   <- junk
 *   L3445613  Tech Sticker Coll      46 stores, 2628 units  <- real
 *   L3445571  Elite Trainer Box      58 stores, 2799 units  <- real
 *   L3445579  Knockout Collection    46 stores, 3696 units  <- real
 *
 * The gap is two orders of magnitude, so the threshold sits far from both classes rather than
 * being tuned to the boundary. It is a screen, not an identification: anything that passes is
 * still reported for a human to confirm before it can reach the client channel, because n=7 is
 * too small to bet a customer-facing alert on and a large candy shipment would clear it.
 */

const IMAGE_BASE = process.env.LD_IMAGE_BASE
  || 'https://cdn-tp2.mozu.com/28945-m4/cms/files';

// Deliberately far from both observed classes. Junk topped out at 13 units across 11 stores;
// the smallest real allocation was 2,628 units across 46. Tightening these to sit near the
// boundary would be fitting to seven samples.
const MIN_STORES = Number(process.env.LD_DISCOVERY_MIN_STORES || 2);
const MIN_UNITS = Number(process.env.LD_DISCOVERY_MIN_UNITS || 24);

const CLASS = { VISIBLE: 'visible', HIDDEN: 'hidden', MISSING: 'missing', UNKNOWN: 'unknown' };

/** The code space is ~5% populated, so most probes are misses. */
function productUrl(code) {
  return `https://www.londondrugs.com/api/product/${code}`;
}

/** Box art resolves for hidden codes too — a different CDN host, with no bot protection. */
function imageUrl(code) {
  return `${IMAGE_BASE}/${code}.jpg`;
}

function formatCode(n) {
  return `L${String(n).padStart(7, '0')}`;
}

function codeNumber(code) {
  const m = /^L(\d+)$/.exec(String(code || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Classify one /api/product/<code> response.
 *
 * UNKNOWN is a distinct outcome and must never be collapsed into MISSING: 1.1% of probes came
 * back as a transient origin 500, and treating those as "code never issued" would permanently
 * skip real products, silently. An unknown code is simply re-probed next pass.
 */
function classifyProductResponse(payload) {
  let json = payload;
  if (typeof json === 'string') {
    try { json = JSON.parse(json); } catch { return { klass: CLASS.UNKNOWN, name: null }; }
  }
  if (!json || typeof json !== 'object') return { klass: CLASS.UNKNOWN, name: null };

  if (json.isSuccess === true) {
    const d = json.data || {};
    const name = (d.product && d.product.productName) || d.productName || null;
    return { klass: CLASS.VISIBLE, name: typeof name === 'string' ? name : null };
  }

  const msg = Array.isArray(json.errors) && json.errors[0] ? String(json.errors[0].message || '') : '';
  if (/\bis hidden\b/i.test(msg)) return { klass: CLASS.HIDDEN, name: null };
  if (/\bnot found\b/i.test(msg)) return { klass: CLASS.MISSING, name: null };
  return { klass: CLASS.UNKNOWN, name: null };
}

/** Stock shape for a candidate: how widely it landed, and how much of it there is. */
function stockShape(rows) {
  const hits = (rows || []).filter((r) => r && r.stockAvailable > 0);
  return {
    stores: hits.length,
    units: hits.reduce((sum, r) => sum + r.stockAvailable, 0),
  };
}

/**
 * Is this hidden code worth a human's attention?
 *
 * Zero stock is NOT a rejection of the product — London Drugs provisions the code before the
 * shipment lands (L3445587 and L3445595 both existed with no stock anywhere while being genuine
 * 30th Celebration product). It means "not yet", and the code stays under watch.
 */
function isAlertworthy(rows) {
  const { stores, units } = stockShape(rows);
  return stores >= MIN_STORES && units >= MIN_UNITS;
}

/**
 * The codes to probe next.
 *
 * Only ever forward of what we have already resolved, and only codes we have not settled:
 * VISIBLE and HIDDEN are terminal, MISSING and UNKNOWN are re-probed because a code can be
 * issued later. `resolved` is a plain object so it round-trips through Redis unchanged.
 */
function nextScanBatch(frontier, resolved = {}, size = 200) {
  const start = codeNumber(frontier);
  if (start == null) return [];
  const out = [];
  for (let n = start + 1; out.length < size && n <= start + size * 4; n++) {
    const code = formatCode(n);
    const known = resolved[code];
    if (known === CLASS.VISIBLE || known === CLASS.HIDDEN) continue;
    out.push(code);
  }
  return out;
}

module.exports = {
  CLASS,
  MIN_STORES,
  MIN_UNITS,
  productUrl,
  imageUrl,
  formatCode,
  codeNumber,
  classifyProductResponse,
  stockShape,
  isAlertworthy,
  nextScanBatch,
};
