/**
 * Pokemon Center grid probe. OBSERVE-ONLY, runs as its own Railway service, never src/index.js.
 *
 * WHAT THE RUNS SO FAR SETTLED (all on the live store, residential exit, 2026-09-15 and -16):
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
 *   Probe 4  Settled the sold-out direction on ?page=8: JSON 32 products, 32 sold out, 0
 *            unreadable, against 34 DOM anchors with the same 32 verdicts and 2 unreadable.
 *            `outOfStock: true` confirmed, with the price still present. It also read the
 *            "Items per page" control properly (button#per-page plus a div[role="menu"], empty
 *            until clicked): the options are 32, 64 and 96, and choosing 96 moved the URL to
 *            ?page=1&ps=96.
 *
 *            That last step is also where it found the trap. The selection happened CLIENT-SIDE,
 *            which fired GET /tpci-ecommweb-api/search?...&fl=availability_status,... -- a
 *            DataDome-protected endpoint that returned 403 and drew a captcha naming that search
 *            URL as its referer. The grid never re-rendered and __NEXT_DATA__ stayed frozen on
 *            the ?page=8 payload. Both plain document navigations rendered cleanly.
 *
 *   Probe 5  ?ps=96 WORKS as a plain navigation. One load of the category with no page parameter
 *            returned 95 products in __NEXT_DATA__ -- 95 in stock, 0 unreadable -- against 97 DOM
 *            anchors, the two extras being the same mega-menu links as every other run. The
 *            earlier headed sweep needed 5 pages at 32 to cover 129 products; at 96 that is 2.
 *
 *            This, not the JSON, is the answer to the rate limit. Reading the document instead of
 *            the tiles saves no requests at all -- it is the same page load -- and page loads are
 *            the only thing the site counts.
 *
 *   The UI-driving code is GONE rather than left switched off. Its question is answered, and
 *   Probe 4 showed that clicking through this store's controls is what draws the captcha. Ask for
 *   ?ps=N in the URL instead.
 *
 * WHAT IS STILL UNMEASURED: the tolerable CADENCE. The sweep was rate-limited at 4s page spacing
 * on 2026-09-13 and recovered after ~90 minutes. Fewer, larger pages makes that easier but does
 * not answer it, and shipping a sweep at a pace that gets the residential pool flagged is worse
 * than having no Pokemon Center data.
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
 *                 PROBE_PAGE_SIZE, PROBE_SPACING_MS
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
// Probe 5: the `ps` URL parameter. Probe 4 read the options straight off the opened control —
// 32, 64 and 96 — and selecting 96 moved the URL to ?page=1&ps=96. That selection happened
// client-side and was blocked, so the parameter is KNOWN but its effect is not. Set
// PROBE_PAGE_SIZE=96 to ask for it on a real navigation. Unset means ask for nothing.
const PAGE_SIZE = Number(process.env.PROBE_PAGE_SIZE) || 0;
// Probe 6: ask the search endpoint the page itself uses. PROBE_SEARCH_API=1 to enable.
const SEARCH_API = process.env.PROBE_SEARCH_API === '1';
// How many rows to ask for on the SECOND call, only if the first one is allowed through.
const SEARCH_ROWS = Math.max(1, Number(process.env.PROBE_SEARCH_ROWS) || 200);
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
 * Ask the Bloomreach search endpoint the page itself calls.
 *
 * WHY THIS IS WORTH ASKING AGAIN. Probe 4 saw
 *
 *   GET /tpci-ecommweb-api/search?...&fl=availability_status,...&rows=95&start=0
 *
 * return 403, with DataDome serving a captcha that named it as the referer. That looked like a
 * closed door. But it happened DURING the in-app page-size transition, after the click had
 * already provoked DataDome -- and in the very same session three sibling endpoints answered
 * normally: review/get-product-scores (200), cart/data (200), profile/data (200). So the API
 * family is not blocked; one request in a poisoned state was.
 *
 * If it answers from a cleanly rendered page, this changes everything about cadence. `rows` is
 * the page size and `start` the offset -- rows=95 is exactly what ?ps=96 produced -- so the whole
 * catalogue could come back in one or two calls instead of a page load per 96 products, and the
 * spacing problem stops being the binding constraint.
 *
 * Deliberately conservative: it is called from a page that rendered through a plain navigation
 * with no clicking, it is a same-origin fetch so the browser sends the session's own cookies and
 * headers, and the wider `rows` call is only attempted if the first is allowed through. Nothing
 * is retried -- a 403 is an answer, and hammering it is how the exit gets scored.
 */
async function probeSearchApi(page, slug) {
  const FL = ['availability_status', 'best_seller', 'brand', 'currency', 'description',
    'display_price', 'display_sale_price', 'launch_date', 'pid', 'PRF', 'price_range', 'price',
    'primary_image', 'primary_image_full_size', 'promotions', 'reporting_crumb',
    'reporting_product_name', 'sale_price_range', 'sale_price', 'thumb_image', 'title', 'url'].join(',');

  const build = (rows, start) => {
    const p = new URLSearchParams({
      _br_uid_2: '', fl: FL, q: slug, ref_url: '', rows: String(rows),
      search_type: 'category', sort: '', start: String(start),
      url: `https://www.pokemoncenter.com/en-ca/category/${slug}`, view_id: 'pokemon-ca',
    });
    return `/tpci-ecommweb-api/search?${p.toString()}`;
  };

  // Same-origin fetch from inside the rendered page: the session's cookies and headers go with it.
  const ask = (url) => page.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
      const body = await res.text();
      return { status: res.status, type: res.headers.get('content-type') || '', bytes: body.length, body };
    } catch (e) { return { error: String(e && e.message) }; }
  }, url).catch((e) => ({ error: e.message }));

  const first = await ask(build(95, 0));
  log('SEARCH_API', {
    rows: 95, start: 0, status: first.status, bytes: first.bytes, type: first.type,
    error: first.error, verdict: first.status === 200 ? 'ALLOWED' : 'blocked',
  });
  if (!first || first.status !== 200 || !first.body) return;

  // Only now, and only once: does it hand over more than a page's worth in a single call?
  logBody('search-95', first.body);
  const wide = await ask(build(SEARCH_ROWS, 0));
  log('SEARCH_API_WIDE', {
    rows: SEARCH_ROWS, status: wide.status, bytes: wide.bytes, error: wide.error,
    verdict: wide.status === 200 ? `rows=${SEARCH_ROWS} ALLOWED` : 'blocked',
  });
  if (wide.status === 200 && wide.body) logBody('search-wide', wide.body);
}

/**
 * The grid as the document itself reports it, through the same parser the adapter uses.
 *
 * Probe 4 confirmed `outOfStock: true` on ?page=8 — 32 of 32 sold out, 0 unreadable — so the raw
 * dump below is now a REGRESSION check rather than an open question. If that field ever starts
 * rendering some other way, this is where it shows up, which is why one sold-out product object
 * is logged verbatim and not merely counted.
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
    log('JSON_SOLDOUT_CONFIRMED', { count: 0, note: 'no sold-out product on this page (confirmed on ?page=8, 2026-09-16)' });
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
      // Built as a real navigation, never by driving the pager. Probe 4 established that the
      // in-app route change is what the site defends: it fires the DataDome-protected
      // /tpci-ecommweb-api/search endpoint, which 403s and draws a captcha, while a plain
      // document load renders cleanly every time.
      const qs = [];
      if (pageNo > 1) qs.push(`page=${pageNo}`);
      if (PAGE_SIZE) qs.push(`ps=${PAGE_SIZE}`);
      const url = `https://www.pokemoncenter.com/en-ca/category/${SLUG}${qs.length ? `?${qs.join('&')}` : ''}`;
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

      // The grid as the document reports it, through the parser the adapter uses. PAGESIZE_CHECK
      // is the whole point of Probe 5: if ?ps=96 returns 96 products on a plain navigation, a
      // sweep covers the same catalogue in a third of the page loads, and page loads are the
      // only thing the rate limit actually counts.
      const summary = await summarizeJson(page);
      if (SEARCH_API && pageNo === START_PAGE) await probeSearchApi(page, SLUG);
      log('PAGESIZE_CHECK', {
        requested: PAGE_SIZE || 'default', landed: page.url(),
        jsonProducts: summary ? summary.total : null, tiles: tiles.length,
        verdict: !summary ? 'no products array'
          : (PAGE_SIZE && summary.total > 32 ? `ps=${PAGE_SIZE} WORKS` : 'no more than the default 32'),
      });

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
