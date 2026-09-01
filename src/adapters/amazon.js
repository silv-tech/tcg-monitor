const BaseAdapter = require('./base');
const cheerio = require('cheerio');
const logger = require('../monitoring/logger');
const { normalizePrice } = require('../utils/helpers');
const { classifyError } = require('../core/failure-reasons');

let cookieSession;
try { cookieSession = require('../utils/cookie-session'); } catch { cookieSession = null; }

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    this.searchUrls = [
      `${this.url}/s?k=pokemon+tcg+booster+box&rh=n%3A6388804011`,
      `${this.url}/s?k=pokemon+elite+trainer+box`,
      `${this.url}/s?k=one+piece+card+game+booster+box`,
      `${this.url}/s?k=pokemon+tcg+collection+box`,
    ];
  }

  _isChallenge(html) {
    if (html.includes('captcha') || html.includes('Robot Check') || html.includes('Enter the characters')) return true;
    if (html.length < 5000) return true;
    // If the response is large but doesn't contain search results, we got a redirect/block page
    if (!html.includes('s-search-result') && !html.includes('data-asin')) return true;
    return false;
  }

  async fetchProducts() {
    const products = {};

    for (const searchUrl of this.searchUrls) {
      try {
        // Try browser first (free), fall back to ScraperAPI (paid) on challenge
        // ScraperAPI can't bypass Akamai at any tier — browser only, no paid fallback
        const html = await this.protectedFetch(searchUrl, {
          timeoutMs: 30000,
          waitForSelector: '[data-component-type="s-search-result"]',
          challengeDetector: (h) => this._isChallenge(h),
          noScraper: true,
        });

        if (!html || this._isChallenge(html)) {
          logger.warn(`Amazon: all methods returned challenge for ${searchUrl}`, { reason: 'bot_challenge' });
          continue;
        }

        const $ = cheerio.load(html);
        const resultCount = $('[data-component-type="s-search-result"]').length;

        if (resultCount === 0) {
          // Log diagnostic info
          const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || 'unknown';
          logger.warn(`Amazon: 0 results on page. Title: "${title}", HTML: ${html.length} bytes`, { reason: 'parse_error' });
          continue;
        }

        $('[data-component-type="s-search-result"]').each((_, el) => {
          try {
            const $el = $(el);
            const asin = $el.attr('data-asin');
            if (!asin) return;

            const name = $el.find('h2 .a-text-normal, h2 a span').first().text().trim();
            if (!name) return;

            // Skip non-TCG results
            const lowerName = name.toLowerCase();
            const isTCG = ['pokemon', 'tcg', 'card game', 'booster', 'trainer box', 'one piece'].some(
              kw => lowerName.includes(kw)
            );
            if (!isTCG) return;

            const href = $el.find('h2 a').first().attr('href') || '';
            const url = href.startsWith('http') ? href : `${this.url}${href}`;

            const priceWhole = $el.find('.a-price .a-price-whole').first().text().replace(',', '');
            const priceFraction = $el.find('.a-price .a-price-fraction').first().text();
            let price = null;
            if (priceWhole) {
              price = parseFloat(`${priceWhole}.${priceFraction || '00'}`);
            }

            const image = $el.find('.s-image').first().attr('src') || '';

            // Skip third-party sellers — only show "Ships from and sold by Amazon.ca"
            const sellerText = $el.find('.a-row.a-size-base .a-color-secondary, .s-merchant-info').text().toLowerCase();
            if (sellerText && !sellerText.includes('amazon') && sellerText.includes('sold by')) return;

            const outOfStock = $el.find('.a-color-error').text().toLowerCase().includes('currently unavailable') ||
              $el.text().toLowerCase().includes('currently unavailable');

            const product = this.classify({
              sku: asin,
              name,
              price,
              currency: 'CAD',
              url,
              image,
              inStock: !outOfStock && price != null,
              canAddToCart: !outOfStock && price != null,
              shipsToHome: true,
            });

            products[product.sku] = product;
          } catch (err) {
            logger.debug(`Amazon: failed to parse result: ${err.message}`);
          }
        });
      } catch (err) {
        logger.warn(`Amazon: failed to fetch search: ${err.message}`, { reason: classifyError(err) });
      }
    }

    if (Object.keys(products).length === 0 && this.searchUrls.length > 0) {
      throw new Error('All searches returned 0 products — Akamai may be blocking');
    }

    return products;
  }
}

module.exports = AmazonAdapter;
