const logger = require('../monitoring/logger');

let patchright;

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
    if (!patchright) patchright = require('patchright');
  } catch {
    launching.delete(cacheKey);
    throw new Error('patchright not installed');
  }

  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
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

  try {
    const browser = await patchright.chromium.launch(opts);
    browserCache.set(cacheKey, browser);
    launching.delete(cacheKey);
    logger.info(`Cookie session: browser launched (proxy: ${proxyUrl ? 'yes' : 'direct'})`);
    return browser;
  } catch (err) {
    launching.delete(cacheKey);
    throw err;
  }
}

async function createStealthContext(browser) {
  // Patchright handles UA, webdriver, automation signals natively — no manual patches needed
  const context = await browser.newContext({
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport: { width: 1920, height: 1080 },
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
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return cached.cookieString;
      }
      // Expired — remove stale entry so it's not reused
      cookieCache.delete(domain);
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
      cookies, // Keep full cookie objects for browser injection
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
  const { proxyUrl, timeoutMs = 30000, waitForSelector, seedUrl } = opts;

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
    const domain = new URL(url).hostname;

    // Inject cached cookies first
    const cached = cookieCache.get(domain);
    if (cached && cached.cookies && cached.cookies.length > 0) {
      await context.addCookies(cached.cookies);
    }

    // If seedUrl provided, solve the challenge there first (same context)
    if (seedUrl) {
      await page.goto(seedUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch {}
      logger.debug(`Cookie session: seeded ${domain} before fetching product page`);
    }

    // Navigate to the actual target URL
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: 15000 });
      } catch {
        // Selector not found (e.g. OOS product has no add-to-cart button)
      }
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch {
      // OK
    }

    const html = await page.content();
    const cookies = await context.cookies();

    logger.info(`Cookie session: browserFetch ${domain} — HTML: ${html.length} bytes, cookies: ${cookies.length}`);

    if (cookies.length > 0) {
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      cookieCache.set(domain, {
        cookieString,
        cookies,
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
