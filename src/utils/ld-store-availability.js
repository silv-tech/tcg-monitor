/**
 * London Drugs per-store availability.
 *
 * Every London Drugs TCG item is InStorePickup with no DirectShip, so "in stock" without a
 * location is close to useless — the buyer cannot act on it. The site does expose per-store
 * stock, but only behind a store selection, and finding it took a full investigation:
 *
 *   - The product payload carries ONE number, `inventory.onlineStockLevel`, with no store
 *     dimension. Online stock and shelf stock are genuinely different: one item measured 318
 *     online and 0 at every Vancouver store.
 *   - There is no REST endpoint. The site moves this over a Next.js SERVER ACTION — a POST to
 *     the product's own URL carrying a `Next-Action` header. That is why 1.9MB of app bundles
 *     contained no endpoint and no "check other stores" vocabulary: there is no path to find.
 *   - It cannot be called without a browser. Measured 2026-09-08: direct POST 403 (DataDome),
 *     Bright Data Web Unlocker silently drops the custom headers and returns the plain page,
 *     ScraperAPI 500s on POST to a protected domain, and harvesting the browser's cookies and
 *     replaying them from elsewhere is 403 because the cookie is bound to the issuing IP.
 *     Inside a Bright Data browser session it returns 65KB of real store data every time.
 *
 * So this is ENRICHMENT, not a poll path. One session covers many products — measured 22.1s to
 * open, then 1.5-4.0s per product — so the whole in-stock catalogue costs about a minute. It
 * runs on a slow timer and alerts carry the last known store. That trade is only acceptable
 * because London Drugs is pickup-only and therefore not a checkout race; never copy this shape
 * to a retailer where seconds decide the outcome.
 */

const logger = require('../monitoring/logger');

// Rotates when London Drugs deploys, exactly like Walmart's DynamicItemById hash. When store
// data goes silent, re-capture it by driving the store picker over CDP and logging POSTs — the
// method is recorded in the project notes.
const ACTION_ID = process.env.LD_STORE_ACTION_ID
  || '5bfa94ae3116cc94d06a9f4419c282e9cc3c1161';

// London Drugs is Western Canada only — BC, Alberta, Saskatchewan, Manitoba. The action returns
// stores NEAR a postal code, so one code per province is what covers the chain. Adding codes
// costs ~3s per product per code, so this is deliberately short.
const POSTAL_CODES = (process.env.LD_STORE_POSTAL_CODES
  || 'V6B 1A1,T2P 1J9,S4P 3Y2,R3C 4T3').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Pull the store rows out of a server-action response.
 *
 * The body is React Flight, not JSON — lines like `1:{"isSuccess":true,...}` — so the payload
 * is located rather than JSON.parsed whole. Anything unparseable yields [] instead of throwing:
 * a failed enrichment must leave the alert without a store, never block or corrupt it.
 */
function parseStoreResponse(text) {
  if (!text || typeof text !== 'string') return [];
  const start = text.indexOf('"data":[');
  if (start === -1) return [];

  // Walk the array with a brace counter — a regex cannot match nested objects reliably.
  const open = text.indexOf('[', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return [];

  let rows;
  try { rows = JSON.parse(text.slice(open, end + 1)); } catch { return []; }
  if (!Array.isArray(rows)) return [];

  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    // Only accept rows that are actually stores. `"data":[...]` is not unique to this action —
    // posting from the wrong route returns a different payload whose first data array parsed
    // into rows with no stockAvailable, i.e. silently "no stock everywhere". Requiring the
    // shape means a wrong payload yields nothing at all, which is visible, instead of
    // plausible-looking zeros, which are not.
    const looksLikeStore = (r.locationCode || r.code) && r.name && r.address
      && typeof r.stockAvailable !== 'undefined';
    if (!looksLikeStore) continue;
    const addr = r.address || {};
    const qty = Number(r.stockAvailable);
    out.push({
      code: r.locationCode || r.code || null,
      name: r.name || null,
      // Distance comes back in metres.
      distanceM: Number.isFinite(Number(r.distance)) ? Number(r.distance) : null,
      stockAvailable: Number.isFinite(qty) ? qty : 0,
      address1: addr.address1 || '',
      city: addr.cityOrTown || '',
      province: addr.stateOrProvince || '',
      postal: addr.postalOrZipCode || '',
      phone: r.phone || '',
    });
  }
  return out;
}

/** Stores that actually have units, nearest first. */
function storesWithStock(stores) {
  return (stores || [])
    .filter((s) => s && s.stockAvailable > 0)
    .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
}

/**
 * The embed line. Names the nearest store holding units and says how many others also do.
 *
 * Returns null when nothing has stock, so the alert simply omits the field. An enrichment that
 * found no store must not render as "not available anywhere" — we may just have missed it.
 */
function formatStoreField(stores) {
  const hits = storesWithStock(stores);
  if (hits.length === 0) return null;
  const s = hits[0];
  const where = [s.address1, s.city, s.province].filter(Boolean).join(', ');
  const km = s.distanceM != null ? ` · ${(s.distanceM / 1000).toFixed(1)}km` : '';
  const more = hits.length > 1 ? `\n+${hits.length - 1} other store${hits.length > 2 ? 's' : ''} in stock` : '';
  return `**${s.name}** — ${s.stockAvailable} in stock${km}\n${where} ${s.postal}`.trim() + more;
}

/** The exact request the site makes. Kept in one place so a captured change lands once. */
function buildActionRequest(productUrl, productCode, zipCode) {
  return {
    url: productUrl,
    method: 'POST',
    headers: {
      'Next-Action': ACTION_ID,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'text/x-component',
    },
    body: JSON.stringify([productCode, { zipCode }]),
  };
}

/**
 * Enrich products with store availability using ONE browser session for all of them.
 *
 * `openSession` is injected so the browser is not a hard dependency of this module — the tests
 * drive the whole loop without a network call, and a caller with no Bright Data endpoint gets
 * an empty map rather than an exception.
 *
 * @param {Array<{sku:string,url:string}>} products
 * @param {{openSession:Function, postalCodes?:string[], perProductDelayMs?:number}} opts
 * @returns {Promise<Map<string, Array>>} sku -> store rows (merged across postal codes)
 */
async function fetchStoreAvailability(products, opts = {}) {
  const result = new Map();
  const list = (products || []).filter((p) => p && p.sku && p.url);
  if (list.length === 0) return result;

  const openSession = opts.openSession;
  if (typeof openSession !== 'function') {
    logger.debug('London Drugs: store availability skipped — no browser session available');
    return result;
  }

  const codes = opts.postalCodes && opts.postalCodes.length ? opts.postalCodes : POSTAL_CODES;
  let session;
  try {
    session = await openSession();
  } catch (err) {
    logger.warn(`London Drugs: could not open a browser session for store availability: ${err.message}`);
    return result;
  }

  const started = Date.now();
  let ok = 0;
  let withStock = 0;
  let totalRows = 0;
  try {
    for (const p of list) {
      const byCode = new Map(); // dedupe: the same store answers several postal codes
      for (const zip of codes) {
        try {
          const text = await session.post(buildActionRequest(p.url, p.sku, zip));
          for (const s of parseStoreResponse(text)) {
            if (s.code && !byCode.has(s.code)) byCode.set(s.code, s);
          }
        } catch (err) {
          logger.debug(`London Drugs: store lookup failed for ${p.sku} @ ${zip}: ${err.message}`);
        }
      }
      if (byCode.size > 0) {
        const rows = [...byCode.values()];
        result.set(p.sku, rows);
        ok++;
        withStock += storesWithStock(rows).length > 0 ? 1 : 0;
        totalRows += rows.length;
      }
    }
  } finally {
    try { await session.close(); } catch { /* the session is disposable */ }
  }

  // "9/9 products" alone was a misleading success line: it counted products that returned ANY
  // rows, so a payload full of rows with no stock read as a clean pass while every alert
  // silently lost its store field. The counts that matter are rows parsed and products that
  // actually have units somewhere.
  logger.info(`London Drugs: store availability — ${ok}/${list.length} products, ` +
    `${totalRows} store rows, ${withStock} with stock, across ${codes.length} region(s) ` +
    `in ${Math.round((Date.now() - started) / 1000)}s`);
  return result;
}

/**
 * A Bright Data browser session, wrapped down to the two calls the loop needs.
 *
 * Bright Data is the only route that works here, and `connectOverCDP` needs a generous timeout:
 * the 30s default expires before a session is even allocated (measured: 22.1s just to open).
 * The page must be loaded once so the action is posted from a real same-origin context — the
 * cookies that makes are what the request is authorised by, and they cannot be replayed from
 * anywhere else.
 */
function createBrightDataSession(seedUrl) {
  const ws = process.env.BRIGHTDATA_BROWSER_WS;
  if (!ws) return null;
  return async () => {
    const { chromium } = require('patchright');
    const browser = await chromium.connectOverCDP(ws, { timeout: 180000 });
    const ctx = await browser.newContext({ locale: 'en-CA' });
    const page = await ctx.newPage();
    await page.goto(seedUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000);
    return {
      post: (req) => page.evaluate(
        async ({ url, headers, body }) => {
          const res = await fetch(url, { method: 'POST', headers, body });
          return res.text();
        },
        { url: req.url, headers: req.headers, body: req.body },
      ),
      close: () => browser.close(),
    };
  };
}

module.exports = {
  createBrightDataSession,
  parseStoreResponse,
  storesWithStock,
  formatStoreField,
  buildActionRequest,
  fetchStoreAvailability,
  ACTION_ID,
  POSTAL_CODES,
};
