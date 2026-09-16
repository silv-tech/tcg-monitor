/**
 * Pokemon Center grid probe. OBSERVE-ONLY, runs as its own Railway service, never src/index.js.
 *
 * WHAT THE FIRST THREE RUNS SETTLED (all on the live store, 2026-09-15, residential exit):
 *
 *   Probe 1  NO XHR fills the grid. The only calls are Imperva and DataDome sensors, review
 *            scores, cart and profile. The products arrive in the document. So there is no API
 *            to call instead of a page load, and the rate limit cannot be fixed that way.
 *   Probe 2  __NEXT_DATA__ is 566KB, pageProps empty, appProps.pageSize 32, and its array walk
 *            found no product list. window.next.router is not exposed.
 *   Probe 3  The products were there all along, at
 *            $.props.initialState.search.results.products -- 31 entries against 33 DOM anchors,
 *            each with a boolean `outOfStock`, purchasePrice/listPrice, images and releaseDate.
 *            The two extra anchors are the mega-menu's own product links, which is also why two
 *            tiles read as unreadable. Its "Items per page" attempt returned nothing, because it
 *            queried the whole page and matched the mega-menu's nav list.
 *
 * WHAT PROBE 4 IS FOR, on one more single visit:
 *
 *   1. `outOfStock: true` has still NEVER been observed -- page 1 is 31 of 31 in stock. Set
 *      PROBE_START_PAGE=8 (measured 32 of 34 sold out on 2026-09-13) and dump one raw sold-out
 *      object. Until that exists, the JSON path cannot be trusted in the sold-out direction, and
 *      src/adapters/pokemoncenter-nextdata.js stays a cross-check rather than the source.
 *   2. Whether "Items per page" offers more than 32. At 32 the rate limit is the binding
 *      constraint; 96 is a third of the page loads for the same coverage.
 *
 * It loads PROBE_PAGES category pages (default 1) starting at PROBE_START_PAGE with
 * PROBE_SPACING_MS between them, using the exact launch shape that rendered on 2026-09-13
 * (headed Chromium, Xvfb, residential exit), logs every XHR/fetch the page makes plus the DOM
 * tile verdicts and the JSON products for comparison, then IDLES FOREVER. Idling is deliberate:
 * exiting would let Railway restart the service and re-hit the site in a loop, which is exactly
 * how an exit gets flagged. Nothing is written to Redis or Discord.
 *
 * Start command:  node scripts/pc-grid-probe.js
 * Env:            PROXY_RESIDENTIAL_URL (required), PROBE_SLUG, PROBE_PAGES, PROBE_START_PAGE,
 *                 PROBE_SPACING_MS
 */
const { spawn } = require('child_process');
const { chromium } = require('patchright');
// The verdict module, NOT the adapter: the adapter loads src/config, which exits in production
// without admin auth, and an exiting probe gets restarted into a loop against the site.
const { pcVerdict } = require('../src/adapters/pokemoncenter-verdict');
// Also dependency-free, and for the same reason. Probe 3 found the grid's products in the
// document at $.props.initialState.search.results.products; this is the one parsed copy of that.
const { pcProductsFromNextData } = require('../src/adapters/pokemoncenter-nextdata');

const SLUG = process.env.PROBE_SLUG || 'trading-card-game';
const PAGES = Math.max(1, Number(process.env.PROBE_PAGES) || 1);
// Probe 4: the page to land on. Page 1 of trading-card-game is 31 of 31 IN STOCK, which is why
// `outOfStock: true` has still never been observed. Page 8 measured 32 of 34 sold out on
// 2026-09-13, so PROBE_START_PAGE=8 is what turns the last assumption into a measurement.
const START_PAGE = Math.max(1, Number(process.env.PROBE_START_PAGE) || 1);
const SPACING_MS = Math.max(30000, Number(process.env.PROBE_SPACING_MS) || 60000);
const BODY_LOG_CHARS = 24000;
const CHUNK = 3000;

const log = (tag, obj) => console.log(`[probe] ${tag} ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`);
const redact = (h) => Object.fromEntries(Object.entries(h || {}).map(([k, v]) =>
  (/authorization|cookie|token|x-.*key/i.test(k) ? [k, `<redacted ${String(v).length}>`] : [k, v])));

// Long bodies are split so a log line limit cannot truncate the one thing we came for.
function logBody(id, body) {
  const text = body.slice(0, BODY_LOG_CHARS);
  for (let i = 0, n = 0; i < text.length; i += CHUNK, n += 1) {
    console.log(`[probe] BODY ${id} #${n} ${text.slice(i, i + CHUNK)}`);
  }
}

// Same extractor as the adapter's pcExtractTiles; duplicated because page.evaluate serialises it.
function extractTiles() {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/en-ca/product/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/product\/([^/]+)\/([^/?#]*)/);
    if (!m || seen.has(m[1])) continue;
    let el = a;
    let hops = 0;
    while (el && hops < 6 && !/\$\s*\d+\.\d{2}/.test(el.innerText || '')) { el = el.parentElement; hops += 1; }
    if (!el) continue;
    seen.add(m[1]);
    out.push({ sku: m[1], text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300) });
  }
  return out;
}

// The image runs as a --system user with no home directory. Chrome needs a writable HOME for its
// profile and crash database; without one it dies at launch with SIGTRAP and
// "chrome_crashpad_handler: --database is required" (first deploy, 2026-09-15).
function ensureWritableHome() {
  const fs = require('fs');
  const home = process.env.HOME;
  let ok = false;
  try { fs.accessSync(home, fs.constants.W_OK); ok = !!home; } catch { ok = false; }
  if (!ok) process.env.HOME = '/tmp/pc-probe-home';
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`;
  process.env.XDG_CACHE_HOME = `${process.env.HOME}/.cache`;
  log('HOME', { original: home || null, writable: ok, using: process.env.HOME });
}

// Probe 3 answered where the products live, and src/adapters/pokemoncenter-nextdata.js now
// carries that path as the one parsed copy, so the __NEXT_DATA__ SKU hunt has been removed.

/**
 * Choose the largest "Items per page" the way a shopper would, and count what comes back.
 *
 * WHY PROBE 3 GOT NOTHING HERE. It searched the whole page for `[role="option"], [role="listbox"]
 * li, ul li`, and the first thing that matches on this site is the mega-menu's navigation list —
 * so it collected "Plush", "Figures", "Pins", found no numbers, and silently gave up
 * (PAGESIZE_OPTIONS numeric: []). The real control, from Probe 3's own PAGESIZE_CONTROL dump, is
 *
 *   <button id="per-page" data-toggle="select" aria-haspopup="true" aria-expanded="false">
 *   <div class="select-menu--..." role="menu" aria-labelledby="per-page">
 *
 * a role="menu", not a listbox, and EMPTY until the button is clicked. So: scope every query to
 * that one container, and dump its markup once it is open rather than guessing the item role.
 *
 * Why it is worth another visit at all: appProps.pageSize is 32, and the rate limit — not the
 * parsing — is what stops this store being swept. A 96-item page is a third of the page loads
 * for the same coverage.
 */
async function probePageSize(page) {
  const control = await page.evaluate(() => {
    const btn = document.getElementById('per-page');
    if (!btn) return null;
    const menu = document.querySelector('[role="menu"][aria-labelledby="per-page"]');
    return {
      button: btn.outerHTML.slice(0, 600),
      menuBefore: menu ? menu.outerHTML.slice(0, 1500) : null,
    };
  }).catch((e) => ({ error: e.message }));
  log('PAGESIZE_CONTROL', control || 'not found');
  if (!control || control.error) return;

  let chosen = null;
  try {
    await page.locator('#per-page').click({ timeout: 10000 });
    await page.waitForTimeout(1500);

    // Whatever the items turn out to be, they are inside THIS container and nowhere else.
    const opened = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"][aria-labelledby="per-page"]');
      if (!menu) return null;
      const items = [...menu.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && (el.textContent || '').trim())
        .map((el) => ({ tag: el.tagName, role: el.getAttribute('role') || '', text: (el.textContent || '').trim() }));
      return { html: menu.outerHTML.slice(0, 3000), items };
    }).catch(() => null);
    log('PAGESIZE_MENU_OPEN', opened || 'menu not found after click');

    const nums = (opened ? opened.items : []).map((i) => i.text).filter((t) => /^\d+$/.test(t)).map(Number);
    log('PAGESIZE_OPTIONS', { numeric: nums, items: (opened ? opened.items : []).slice(0, 20) });
    const max = nums.length ? Math.max(...nums) : null;
    if (max) {
      await page.locator('[role="menu"][aria-labelledby="per-page"]')
        .getByText(new RegExp(`^\\s*${max}\\s*$`)).first().click({ timeout: 10000 });
      chosen = `option ${max}`;
    }
  } catch (e) {
    log('PAGESIZE_ACTION_FAILED', e.message.slice(0, 500));
  }
  if (!chosen) return;

  await page.waitForTimeout(10000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(3000);
  const tiles = await page.evaluate(extractTiles).catch(() => []);
  const v = tiles.map((t) => ({ sku: t.sku, ...pcVerdict(t.text) }));
  // Report the JSON count alongside the tile count: the JSON is the grid, the tiles include the
  // mega-menu's own product links (33 anchors for 31 products on 2026-09-15).
  const json = await summarizeJson(page);
  log('PAGESIZE_RESULT', {
    chosen, landed: page.url(), tiles: tiles.length, jsonProducts: json ? json.total : null,
    inStock: v.filter((x) => x.inStock === true).length,
    soldOut: v.filter((x) => x.inStock === false).length,
    unknown: v.filter((x) => x.inStock == null).length,
  });
}

/**
 * The grid as the document itself reports it, through the same parser the adapter uses.
 *
 * The one question left after Probe 3: `outOfStock: true` has never been observed, because the
 * page it loaded was 31 of 31 in stock. If a sold-out product renders with that field set, the
 * JSON path can replace tile-text parsing outright. If it renders some other way, this is where
 * that shows up — so one sold-out product object is dumped verbatim, not just counted.
 */
async function summarizeJson(page) {
  const text = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
  }).catch(() => null);

  const parsed = pcProductsFromNextData(text);
  if (!parsed) {
    log('JSON_PRODUCTS', { present: false, nextDataBytes: text ? text.length : 0 });
    return null;
  }
  const inStock = parsed.products.filter((p) => p.inStock === true);
  const soldOut = parsed.products.filter((p) => p.inStock === false);
  const unknown = parsed.products.filter((p) => p.inStock == null);
  log('JSON_PRODUCTS', {
    present: true, total: parsed.products.length,
    inStock: inStock.length, soldOut: soldOut.length, unknown: unknown.length,
    sample: parsed.products.slice(0, 3),
  });

  // The whole reason for this run. Dump the raw object so the field shape is on the record.
  if (soldOut.length) {
    log('JSON_SOLDOUT_CONFIRMED', { count: soldOut.length, skus: soldOut.slice(0, 10).map((p) => p.sku) });
    const raw = await page.evaluate((sku) => {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return null;
      try {
        const d = JSON.parse(el.textContent);
        const list = d.props.initialState.search.results.products;
        return JSON.stringify(list.find((p) => p && p.code === sku) || null);
      } catch { return null; }
    }, soldOut[0].sku).catch(() => null);
    if (raw) logBody('soldout-raw', raw);
  } else {
    log('JSON_SOLDOUT_CONFIRMED', { count: 0, note: 'no sold-out product on this page — outOfStock:true still unobserved' });
  }
  if (unknown.length) {
    log('JSON_UNREADABLE', { skus: unknown.slice(0, 10).map((p) => p.sku) });
  }
  return { total: parsed.products.length, soldOut: soldOut.length };
}

// Xvfb's own errors used to go to stdio:'ignore', so a display that never came up looked like a
// Chrome crash. Now its stderr is logged and launch waits for the X socket to exist.
async function startDisplay() {
  if (process.env.DISPLAY) return null;
  const fs = require('fs');
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  xvfb.stderr.on('data', (d) => log('XVFB', String(d).trim().slice(0, 500)));
  xvfb.on('exit', (code, sig) => log('XVFB_EXIT', { code, sig }));
  process.env.DISPLAY = ':99';
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync('/tmp/.X11-unix/X99')) { log('DISPLAY', 'ready :99'); return xvfb; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Xvfb did not create /tmp/.X11-unix/X99 within 10s');
}

async function probe() {
  const proxyUrl = process.env.PROXY_RESIDENTIAL_URL;
  if (!proxyUrl) throw new Error('PROXY_RESIDENTIAL_URL is not set');
  const u = new URL(proxyUrl);
  ensureWritableHome();
  await startDisplay();

  const ctx = await chromium.launchPersistentContext('/tmp/pc-probe-profile', {
    headless: false,
    channel: 'chromium',
    proxy: {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    },
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  let callId = 0;
  let pageNo = 0;
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('response', async (res) => {
    const req = res.request();
    const url = res.url();
    if (!/pokemoncenter\.com/.test(url)) return;
    if (!['xhr', 'fetch'].includes(req.resourceType()) && !/tpci-ecommweb-api/.test(url)) return;
    let body = '';
    try { body = await res.text(); } catch { body = ''; }
    const id = `p${pageNo}c${++callId}`;
    const stockKeys = [...new Set(body.match(/"[A-Za-z_]*(?:availab|inventory|stock|purchas|sold)[A-Za-z_]*"/gi) || [])];
    log('CALL', {
      id, method: req.method(), status: res.status(), bytes: body.length, url,
      type: res.headers()['content-type'] || '', stockKeys: stockKeys.slice(0, 25),
      reqHeaders: redact(req.headers()), postData: (req.postData() || '').slice(0, 4000),
    });
    // Only bodies that could be product data are worth the log volume.
    if (/json/i.test(res.headers()['content-type'] || '') && body.length > 1000) logBody(id, body);
  });

  try {
    for (pageNo = START_PAGE; pageNo < START_PAGE + PAGES; pageNo += 1) {
      const url = `https://www.pokemoncenter.com/en-ca/category/${SLUG}${pageNo > 1 ? `?page=${pageNo}` : ''}`;
      const t0 = Date.now();
      const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('a[href*="/en-ca/product/"]', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(8000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(2500);

      const html = await page.content().catch(() => '');
      const tiles = await page.evaluate(extractTiles).catch(() => []);
      const verdicts = tiles.map((t) => ({ sku: t.sku, ...pcVerdict(t.text) }));
      log('PAGE', {
        page: pageNo, navStatus: nav && nav.status(), ms: Date.now() - t0, landed: page.url(),
        blocked: /_Incapsula_Resource|Pardon Our Interruption|Request unsuccessful/i.test(html),
        tiles: tiles.length,
        inStock: verdicts.filter((v) => v.inStock === true).length,
        soldOut: verdicts.filter((v) => v.inStock === false).length,
        unknown: verdicts.filter((v) => v.inStock == null).length,
        nextData: /__NEXT_DATA__/.test(html),
      });
      log('TILES', verdicts.slice(0, 40));

      // PROBE 4, both questions on the same single visit.
      //
      // Probe 3 (2026-09-15) settled where the data lives: the grid's products are in the
      // document at $.props.initialState.search.results.products, each with a boolean
      // `outOfStock`, structured prices and a clean SKU — 31 entries against 33 DOM anchors,
      // the two extras being the mega-menu's own product links. What it did NOT settle:
      //
      //   1. `outOfStock: true` has never been observed, because that page was 31 of 31 in
      //      stock. Land on a page that has sold-out products (PROBE_START_PAGE=8) and dump one
      //      raw object. Until then the JSON path cannot be trusted in the sold-out direction.
      //   2. "Items per page" returned no options, because the query matched the mega-menu's
      //      nav list instead of the role="menu" control. Fixed in probePageSize().
      if (pageNo === START_PAGE) {
        const sku = (verdicts.find((v) => v.inStock === true) || {}).sku;
        const scripts = await page.evaluate((needle) => [...document.scripts]
          .map((s) => ({ id: s.id || '', type: s.type || '', src: (s.src || '').slice(0, 120),
            bytes: (s.textContent || '').length, hits: needle ? (s.textContent || '').split(needle).length - 1 : 0 }))
          .filter((s) => s.hits > 0), sku).catch((e) => [{ error: e.message }]);
        log('SKU_SCRIPTS', { sku, scripts });

        await summarizeJson(page);

        pageNo = START_PAGE + 1;   // calls made by the page-size interaction get the next label
        await probePageSize(page);
        break;
      }
      if (pageNo < START_PAGE + PAGES - 1) await new Promise((r) => setTimeout(r, SPACING_MS));
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

probe()
  .then(() => log('DONE', 'probe finished; idling so the service does not restart and re-hit the site'))
  .catch((err) => log('FAILED', err.stack || err.message))
  .finally(() => setInterval(() => {}, 1 << 30));
