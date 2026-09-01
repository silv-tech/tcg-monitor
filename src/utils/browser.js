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
      browsers.delete(key);
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

  try {
    const browser = await patchright.chromium.launch(launchOpts);
    browsers.set(key, { browser, launching: false });
    logger.info(`Patchright browser launched (proxy: ${proxyUrl ? 'yes' : 'direct'})`);
    return browser;
  } catch (err) {
    browsers.delete(key);
    throw err;
  }
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

/**
 * Scrape Amazon product page for the Offer Listing ID.
 * Only called on alert (not every poll) — result is cached in Redis for 30 days.
 */
async function scrapeAmazonOfferListingId(asin, proxyUrl) {
  const url = `https://www.amazon.ca/dp/${asin}`;
  logger.info(`Scraping Amazon OLID for ${asin}`);

  const b = await getBrowser(proxyUrl);
  const viewport = VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
  const context = await b.newContext({
    locale: 'en-CA',
    timezoneId: 'America/Toronto',
    viewport,
  });
  const page = await context.newPage();

  // Block images/media only
  await page.route('**/*', route => {
    const type = route.request().resourceType();
    if (['image', 'media'].includes(type)) return route.abort();
    return route.continue();
  });

  try {
    await page.goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1500));

    // Extract OLID and seller info from the same page visit (zero extra cost)
    const result = await page.evaluate(() => {
      // ── OLID extraction ──
      let olid = null;
      // Method 1: Hidden input in add-to-cart form
      const input = document.querySelector('input[name="offerListingID"]');
      if (input?.value) olid = input.value;
      // Method 2: data-offer-id attribute
      if (!olid) {
        const el = document.querySelector('[data-offer-id]');
        if (el?.getAttribute('data-offer-id')) olid = el.getAttribute('data-offer-id');
      }
      // Method 3: Parse from twister/buy-box JSON embedded in page
      if (!olid) {
        const scripts = document.querySelectorAll('script[type="text/javascript"]');
        for (const s of scripts) {
          const text = s.textContent || '';
          const match = text.match(/"offerListingID"\s*:\s*"([^"]+)"/);
          if (match) { olid = match[1]; break; }
        }
      }

      // ── Seller extraction ──
      let seller = null;
      // Method 1: Tabular buybox "Sold by" row (modern Amazon layout)
      const buyboxRows = document.querySelectorAll('.tabular-buybox-text, [class*="tabular-buybox"] span');
      for (let i = 0; i < buyboxRows.length; i++) {
        const attr = buyboxRows[i].getAttribute('tabular-attribute-name') || '';
        if (attr.toLowerCase().includes('sold by') || attr.toLowerCase().includes('vendu par')) {
          // The seller name is in this element or the next sibling
          const text = buyboxRows[i].textContent.trim();
          if (text) { seller = text; break; }
        }
      }
      // Method 2: Seller profile link in buybox
      if (!seller) {
        const sellerLink = document.querySelector('#sellerProfileTriggerId');
        if (sellerLink?.textContent?.trim()) seller = sellerLink.textContent.trim();
      }
      // Method 3: merchant-info div (older layout)
      if (!seller) {
        const merchantInfo = document.querySelector('#merchant-info');
        if (merchantInfo) {
          const text = merchantInfo.textContent.trim();
          // Extract seller from "Ships from and sold by Amazon.ca" or "Sold by X and Fulfilled by Amazon"
          const soldByMatch = text.match(/sold by\s+(.+?)(?:\s+and|\s*\.)/i);
          if (soldByMatch) seller = soldByMatch[1].trim();
          else seller = text;
        }
      }
      // Method 4: "Ships from" / "Sold by" in buybox container
      if (!seller) {
        const offerDisplay = document.querySelector('#buybox-tabular, #newBuyBoxPrice, .a-box-inner');
        if (offerDisplay) {
          const text = offerDisplay.textContent;
          const match = text.match(/[Ss]old by[:\s]+([^\n.]+)/);
          if (match) seller = match[1].trim();
        }
      }

      return { olid, seller };
    });

    if (result.olid) {
      logger.info(`Got OLID for ${asin}: ${result.olid.substring(0, 20)}...`);
    } else {
      logger.debug(`No OLID found on page for ${asin}`);
    }
    if (result.seller) {
      logger.info(`Seller for ${asin}: ${result.seller}`);
    }
    return result;
  } catch (err) {
    logger.debug(`OLID/seller scrape failed for ${asin}: ${err.message}`);
    return { olid: null, seller: null };
  } finally {
    await context.close();
  }
}

module.exports = { browserFetch, closeBrowser, scrapeAmazonOfferListingId };
