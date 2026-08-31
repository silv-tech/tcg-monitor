const logger = require('../monitoring/logger');

let playwright;
// P2-9: Cache browsers per proxy URL to prevent proxy conflicts between adapters
const browsers = new Map(); // proxyUrl → { browser, launching }
const NO_PROXY = '__direct__';

/**
 * Optional headless browser fallback for sites that block all HTTP clients.
 * Requires: npm install playwright-core
 * And a Chromium install: npx playwright install chromium
 *
 * Usage in adapters:
 *   const html = await browserFetch(url, { proxyUrl });
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

  if (!playwright) {
    try {
      playwright = require('playwright-core');
    } catch {
      throw new Error('playwright-core not installed. Run: npm install playwright-core && npx playwright install chromium');
    }
  }

  const launchOpts = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
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

  const browser = await playwright.chromium.launch(launchOpts);
  browsers.set(key, { browser, launching: false });
  logger.info(`Browser launched for stealth fetching (proxy: ${proxyUrl ? 'yes' : 'direct'})`);
  return browser;
}

async function browserFetch(url, opts = {}) {
  const { proxyUrl, timeoutMs = 30000, waitForSelector, extractJson = false } = opts;

  const b = await getBrowser(proxyUrl);
  const context = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1920, height: 1080 },
  });

  // Anti-detection: hide Playwright markers
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete window.__playwright;
    delete window.__pw_manual;
  });

  const page = await context.newPage();

  // Block unnecessary resources to speed up loading
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
    }

    // Small delay to let JS execute
    await page.waitForTimeout(1500);

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
