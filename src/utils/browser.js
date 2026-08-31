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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    },
  });

  // Anti-detection: hide Playwright/headless markers
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete window.__playwright;
    delete window.__pw_manual;

    // Chrome runtime mock
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

    // Permissions API — match real Chrome behavior
    const origQuery = window.Permissions?.prototype?.query;
    if (origQuery) {
      window.Permissions.prototype.query = function (params) {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission });
        }
        return origQuery.call(this, params);
      };
    }

    // Plugin/MimeType arrays — real Chrome has at least 2 plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        ];
        arr.item = i => arr[i];
        arr.namedItem = n => arr.find(p => p.name === n);
        arr.refresh = () => {};
        return arr;
      },
    });

    // Languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en-US', 'en'] });

    // Connection
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }),
      });
    }
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

    // Let JS execute — challenge pages need time to resolve
    await page.waitForTimeout(3000);

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
