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

// Xvfb's own errors used to go to stdio:'ignore', so a display that never came up looked like a
// Chrome crash. Now its stderr is logged and launch waits for the X socket to exist.
// Find a known SKU anywhere in __NEXT_DATA__ (as a value OR a key) and log the path plus the
// objects around it. Probe 2's walk only looked for arrays with sku-named keys and saw nothing,
// which does not rule out products keyed by id or stored as an embedded JSON string.
function locateSku(text, sku) {
  if (!text || !sku) { log('SKU_IN_NEXT_DATA', { sku: sku || null, present: false, reason: text ? 'no in-stock sku' : 'no __NEXT_DATA__' }); return; }
  const rawHits = text.split(sku).length - 1;
  let json;
  try { json = JSON.parse(text); } catch (e) { log('SKU_IN_NEXT_DATA', { sku, rawHits, parse: e.message }); return; }
  const hits = [];
  const walk = (node, path, parents) => {
    if (hits.length >= 5) return;
    if (typeof node === 'string') { if (node.includes(sku)) hits.push({ path, parents, embedded: node.length > 200 }); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k.includes(sku)) hits.push({ path: `${path}.${k}`, parents: [v, node], keyed: true });
      walk(v, `${path}.${k}`, [node, ...parents].slice(0, 3));
    }
  };
  walk(json, '$', []);
  log('SKU_IN_NEXT_DATA', { sku, rawHits, paths: hits.map((h) => ({ path: h.path, keyed: !!h.keyed, embedded: !!h.embedded })) });
  if (hits[0]) {
    const [near, outer] = hits[0].parents;
    logBody('sku-near', JSON.stringify(near));
    if (outer && typeof outer === 'object') log('SKU_OUTER_KEYS', Object.keys(outer).slice(0, 60));
  }
}

// Find the "Items per page" control, log what it offers, choose the largest option the way a
// shopper would (no hand-built URL), and count the tiles that result.
async function probePageSize(page) {
  const control = await page.evaluate(() => {
    const label = [...document.querySelectorAll('body *')]
      .find((el) => el.children.length === 0 && /items per page/i.test(el.textContent || ''));
    if (!label) return null;
    let box = label;
    for (let i = 0; i < 4 && box.parentElement; i += 1) {
      box = box.parentElement;
      if (box.querySelector('select, button, [role="listbox"], [role="combobox"]')) break;
    }
    const sel = box.querySelector('select');
    return {
      html: box.outerHTML.slice(0, 3000),
      select: sel ? { options: [...sel.options].map((o) => ({ value: o.value, text: (o.textContent || '').trim() })) } : null,
    };
  }).catch((e) => ({ error: e.message }));
  log('PAGESIZE_CONTROL', control || 'not found');
  if (!control || control.error) return;

  let chosen = null;
  try {
    const box = page.locator('xpath=//*[contains(translate(normalize-space(text()),"ITEMSPERPAGE","itemsperpage"),"items per page")]/ancestor::*[.//select or .//button or .//*[@role="combobox"]][1]');
    if (control.select && control.select.options.length) {
      const best = control.select.options.filter((o) => /^\d+$/.test(o.text))
        .sort((a, b) => Number(b.text) - Number(a.text))[0];
      if (best) { await box.locator('select').first().selectOption(best.value); chosen = `select ${best.text}`; }
    } else {
      await box.locator('button, [role="combobox"]').first().click({ timeout: 10000 });
      await page.waitForTimeout(1500);
      const opts = await page.locator('[role="option"], [role="listbox"] li, ul li').allInnerTexts();
      const nums = opts.map((t) => t.trim()).filter((t) => /^\d+$/.test(t)).map(Number);
      log('PAGESIZE_OPTIONS', { raw: opts.slice(0, 20), numeric: nums });
      const max = nums.length ? Math.max(...nums) : null;
      if (max) {
        await page.locator('[role="option"], [role="listbox"] li, ul li')
          .filter({ hasText: new RegExp(`^\\s*${max}\\s*$`) }).first().click({ timeout: 10000 });
        chosen = `option ${max}`;
      }
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
  log('PAGESIZE_RESULT', {
    chosen, landed: page.url(), tiles: tiles.length,
    inStock: v.filter((x) => x.inStock === true).length,
    soldOut: v.filter((x) => x.inStock === false).length,
    unknown: v.filter((x) => x.inStock == null).length,
  });
}

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

      // Probe 2 (2026-09-15): __NEXT_DATA__ is 566KB, pageProps empty, no product array the walk
      // could see, appProps.pageSize 32; window.next.router is not exposed, so client-side paging
      // could not be tried. The page carries an "Items per page" control. Probe 3, same one visit:
      //   - where does a known SKU sit in the page's data, if anywhere?
      //   - what does "Items per page" offer, and does choosing the largest show more tiles?
      if (pageNo === 1) {
        const sku = (verdicts.find((v) => v.inStock === true) || {}).sku;
        const scripts = await page.evaluate((needle) => [...document.scripts]
          .map((s) => ({ id: s.id || '', type: s.type || '', src: (s.src || '').slice(0, 120),
            bytes: (s.textContent || '').length, hits: needle ? (s.textContent || '').split(needle).length - 1 : 0 }))
          .filter((s) => s.hits > 0), sku).catch((e) => [{ error: e.message }]);
        log('SKU_SCRIPTS', { sku, scripts });
        const nd = await page.evaluate(() => {
          const el = document.getElementById('__NEXT_DATA__');
          return el ? el.textContent : null;
        }).catch(() => null);
        locateSku(nd, sku);

        pageNo = 2;   // calls made by the page-size interaction are labelled p2
        await probePageSize(page);
        break;
      }
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
