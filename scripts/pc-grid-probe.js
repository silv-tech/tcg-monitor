/**
 * Pokemon Center grid probe. OBSERVE-ONLY, runs as its own Railway service, never src/index.js.
 *
 * Question it answers: when the category grid renders, what JSON call fills it, and does that
 * call carry stock? If it does, one API request can replace a page of DOM tiles, which is the
 * difference between a sweep the site rate-limits and one it tolerates.
 *
 * It loads PROBE_PAGES category pages (default 1) with PROBE_SPACING_MS between them, using the
 * exact launch shape that rendered on 2026-09-13 (headed Chromium, Xvfb, residential exit), logs
 * every XHR/fetch the page makes plus the DOM tile verdicts for comparison, then IDLES FOREVER.
 * Idling is deliberate: exiting would let Railway restart the service and re-hit the site in a
 * loop, which is exactly how an exit gets flagged. Nothing is written to Redis or Discord.
 *
 * Start command:  node scripts/pc-grid-probe.js
 * Env:            PROXY_RESIDENTIAL_URL (required), PROBE_SLUG, PROBE_PAGES, PROBE_SPACING_MS
 */
const { spawn } = require('child_process');
const { chromium } = require('patchright');
// The verdict module, NOT the adapter: the adapter loads src/config, which exits in production
// without admin auth, and an exiting probe gets restarted into a loop against the site.
const { pcVerdict } = require('../src/adapters/pokemoncenter-verdict');

const SLUG = process.env.PROBE_SLUG || 'trading-card-game';
const PAGES = Math.max(1, Number(process.env.PROBE_PAGES) || 1);
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

async function startDisplay() {
  if (process.env.DISPLAY) return null;
  const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  process.env.DISPLAY = ':99';
  await new Promise((r) => setTimeout(r, 1500));
  return xvfb;
}

async function probe() {
  const proxyUrl = process.env.PROXY_RESIDENTIAL_URL;
  if (!proxyUrl) throw new Error('PROXY_RESIDENTIAL_URL is not set');
  const u = new URL(proxyUrl);
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
    for (pageNo = 1; pageNo <= PAGES; pageNo += 1) {
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
      if (pageNo < PAGES) await new Promise((r) => setTimeout(r, SPACING_MS));
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

probe()
  .then(() => log('DONE', 'probe finished; idling so the service does not restart and re-hit the site'))
  .catch((err) => log('FAILED', err.stack || err.message))
  .finally(() => setInterval(() => {}, 1 << 30));
