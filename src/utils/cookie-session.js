const logger = require('../monitoring/logger');

let playwright;

// Browser cache: proxyUrl -> browser instance
const browserCache = new Map();
let launching = new Set();

// Cookie cache: domain -> { cookieString, expiresAt }
const cookieCache = new Map();
const COOKIE_TTL = 15 * 60 * 1000; // 15 minutes

async function ensureBrowser(proxyUrl) {
  const cacheKey = proxyUrl || '__direct__';

  if (browserCache.has(cacheKey)) {
    const b = browserCache.get(cacheKey);
    if (b.isConnected()) return b;
    browserCache.delete(cacheKey);
  }

  if (launching.has(cacheKey)) {
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (browserCache.has(cacheKey) && browserCache.get(cacheKey).isConnected()) {
        return browserCache.get(cacheKey);
      }
    }
  }

  launching.add(cacheKey);
  try {
    if (!playwright) playwright = require('playwright-core');
  } catch {
    launching.delete(cacheKey);
    throw new Error('playwright-core not installed');
  }

  const opts = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
    ],
  };

  if (proxyUrl) {
    try {
      const url = new URL(proxyUrl);
      opts.proxy = {
        server: `${url.protocol}//${url.hostname}:${url.port}`,
        username: url.username || undefined,
        password: url.password || undefined,
      };
    } catch (e) {
      logger.warn(`Cookie session: invalid proxy URL: ${e.message}`);
    }
  }

  const browser = await playwright.chromium.launch(opts);
  browserCache.set(cacheKey, browser);
  launching.delete(cacheKey);
  logger.info(`Cookie session: browser launched (proxy: ${proxyUrl ? 'yes' : 'direct'})`);
  return browser;
}

async function createStealthContext(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1920, height: 1080 },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    delete window.__playwright;
    delete window.__pw_manual;
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-CA', 'en-US', 'en'],
    });
  });

  return context;
}

/**
 * Solve a JS challenge (Incapsula, Akamai, etc.) and return session cookies.
 * Uses Playwright to visit a seed URL, waits for challenge scripts to run,
 * then extracts cookies for use with impit stealth HTTP.
 */
async function getSessionCookies(domain, seedUrl, opts = {}) {
  const { proxyUrl, challengeWaitMs = 10000, forceRefresh = false } = opts;

  if (!forceRefresh) {
    const cached = cookieCache.get(domain);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.cookieString;
    }
  }

  logger.info(`Cookie session: solving challenge for ${domain}...`);
  const b = await ensureBrowser(proxyUrl);
  const context = await createStealthContext(b);
  const page = await context.newPage();

  // Only block images/media — keep CSS and JS (needed for challenges)
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  try {
    await page.goto(seedUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(challengeWaitMs);

    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch {
      // networkidle timeout is OK
    }

    const cookies = await context.cookies();

    if (cookies.length === 0) {
      // Log diagnostic info
      const title = await page.title().catch(() => 'unknown');
      const html = await page.content().catch(() => '');
      const hasCaptcha = html.includes('captcha') || html.includes('CAPTCHA') || html.includes('Robot Check');
      logger.warn(`Cookie session: ${domain} returned 0 cookies. Title: "${title}", HTML: ${html.length} bytes, captcha: ${hasCaptcha}`);
      throw new Error(`No cookies received from ${domain} (title: ${title}, captcha: ${hasCaptcha})`);
    }

    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    cookieCache.set(domain, {
      cookieString,
      expiresAt: Date.now() + COOKIE_TTL,
    });

    logger.info(`Cookie session: ${domain} -- ${cookies.length} cookies cached for ${COOKIE_TTL / 60000} min`);
    return cookieString;
  } finally {
    await context.close();
  }
}

/**
 * Fetch a page with full browser rendering and return HTML.
 * Also caches cookies for future impit requests.
 * Used as fallback when cookie-only approach fails.
 */
async function browserFetchWithCookies(url, opts = {}) {
  const { proxyUrl, timeoutMs = 30000, waitForSelector } = opts;

  const b = await ensureBrowser(proxyUrl);
  const context = await createStealthContext(b);
  const page = await context.newPage();

  // Keep CSS and JS for proper rendering
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);

    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: 15000 });
      } catch {
        // Selector not found
      }
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // OK
    }

    const html = await page.content();
    const domain = new URL(url).hostname;
    const cookies = await context.cookies();

    logger.info(`Cookie session: browserFetch ${domain} — HTML: ${html.length} bytes, cookies: ${cookies.length}`);

    if (cookies.length > 0) {
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      cookieCache.set(domain, {
        cookieString,
        expiresAt: Date.now() + COOKIE_TTL,
      });
    }

    return html;
  } finally {
    await context.close();
  }
}

function invalidateSession(domain) {
  cookieCache.delete(domain);
  logger.info(`Cookie session: invalidated ${domain}`);
}

async function closeBrowser() {
  for (const [key, b] of browserCache) {
    if (b.isConnected()) {
      await b.close();
    }
    browserCache.delete(key);
  }
  logger.info('Cookie session: all browsers closed');
}

module.exports = { getSessionCookies, browserFetchWithCookies, invalidateSession, closeBrowser };
