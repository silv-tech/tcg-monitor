const logger = require('../monitoring/logger');

let patchright;
// Cache browsers per proxy URL to prevent proxy conflicts between adapters
const browsers = new Map(); // proxyUrl → { browser, launching }
const NO_PROXY = '__direct__';

/**
 * Patchright-based browser fetch — drop-in replacement for playwright-core
 * with built-in anti-detection (CDP leak fix, automation signal removal).
 * No manual stealth patches needed — Patchright handles them natively.
 */

async function getBrowser(proxyUrl) {
  const key = proxyUrl || NO_PROXY;
  const entry = browsers.get(key);

  if (entry?.browser?.isConnected()) return entry.browser;
  if (entry?.launching) {
    await new Promise(r => setTimeout(r, 2000));
    const retry = browsers.get(key);
    if (retry?.browser?.isConnected()) return retry.browser;
  }

  browsers.set(key, { browser: null, launching: true });

  if (!patchright) {
    try {
      patchright = require('patchright');
    } catch {
      throw new Error('patchright not installed. Run: npm install patchright && npx patchright install chromium');
    }
  }

  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  };

  if (proxyUrl) {
    const url = new URL(proxyUrl);
    launchOpts.proxy = {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  }

  const browser = await patchright.chromium.launch(launchOpts);
  browsers.set(key, { browser, launching: false });
  logger.info(`Patchright browser launched (proxy: ${proxyUrl ? 'yes' : 'direct'})`);
  return browser;
}

// Common viewport sizes to randomize — avoids fingerprinting from a single fixed resolution
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1536, height: 864 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 2560, height: 1440 },
];

async function browserFetch(url, opts = {}) {
  const { proxyUrl, timeoutMs = 30000, waitForSelector, extractJson = false } = opts;

  const b = await getBrowser(proxyUrl);
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];

  const context = await b.newContext({
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport,
  });

  const page = await context.newPage();

  // Block images and media only — DO NOT block fonts/stylesheets (bot detection red flag)
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
    }

    // Simulate human behavior — mouse movements and scroll
    try {
      // Random mouse movements (3-5 points)
      const moves = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < moves; i++) {
        const x = 100 + Math.floor(Math.random() * (viewport.width - 200));
        const y = 100 + Math.floor(Math.random() * (viewport.height - 200));
        await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
        await page.waitForTimeout(200 + Math.floor(Math.random() * 300));
      }
      // Small scroll
      await page.mouse.wheel(0, 200 + Math.floor(Math.random() * 300));
      await page.waitForTimeout(500 + Math.floor(Math.random() * 500));
    } catch { /* behavioral sim is best-effort */ }

    // Randomized wait — let JS execute and challenge scripts resolve
    const delay = 2000 + Math.floor(Math.random() * 2000);
    await page.waitForTimeout(delay);

    let result;
    if (extractJson) {
      result = await page.evaluate(() => document.body.innerText);
      try { result = JSON.parse(result); } catch { /* return as text */ }
    } else {
      result = await page.content();
    }

    return result;
  } finally {
    await context.close();
  }
}

async function closeBrowser() {
  for (const [key, entry] of browsers) {
    if (entry.browser?.isConnected()) {
      await entry.browser.close();
    }
  }
  browsers.clear();
  logger.info('All browsers closed');
}

module.exports = { browserFetch, closeBrowser };
