const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, isTCGProduct, sleep } = require('../utils/helpers');
const { getProxyUrl } = require('../core/proxy');
const { stealthGet, _clearCache } = require('../utils/stealth-http');
const state = require('../core/state');
const { searchQueries: BASE_QUERIES, setQueries: SET_QUERIES } = require('../config/products.json');
const SEARCH_QUERIES = [...BASE_QUERIES, ...(SET_QUERIES || [])];

// Game names that we track — Amazon results MUST match one of these.
// Scoped to Pokemon and One Piece to match every other adapter.
const GAME_NAMES = [
  'pokemon', 'pokémon', 'one piece',
];

// Accessories — never alert on these even if they mention a game name
const ACCESSORY_KEYWORDS = [
  'deck box', 'deckbox', 'playmat', 'play mat', 'sleeves', 'card sleeves',
  'penny sleeves', 'card protector', 'protector case', 'toploader', 'top loader',
  'display case', 'acrylic', 'portfolio', 'binder', 'card binder', 'album',
  'card holder', 'card organizer', 'storage box', 'card storage',
  'pet plastic', 'dice set', 'dice bag', 'coin holder', 'token box', 'token deck',
  'divider', 'accessories',
];

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// How often to run the paid ScraperAPI search for NEW listings. This is the whole
// ScraperAPI bill: 3 queries x 5 credits per run. It does NOT affect restock speed —
// _monitorKnownAsins re-checks every known ASIN on every poll, free, regardless.
const DISCOVERY_INTERVAL_DEFAULT = 30 * 60 * 1000;
const DISCOVERY_INTERVAL_FLOOR = 5 * 60 * 1000;
const AOD_COOLDOWN_MS = 10 * 60 * 1000;

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    this._knownProducts = new Map(); // ASIN → classified product (persists between polls)
    this._lastDiscoveryAt = 0;       // timestamp of last ScraperAPI discovery
    this._monitorSuccessRate = 0;    // track product page stealth success %
    this.watchlist = new Set(config.watchlist || []); // fast-polled by the scheduler
    this._aodCooldownUntil = 0;      // set when Amazon starts 503ing the offer endpoint
    this._lastFetchThrottled = false;
    this._searchWindow = [];         // rolling free-search success
    this._searchSkip = 0;
    this._lastAodSweepAt = 0;
    this._deriveTiming();

    // Shared query set (src/config/products.json) — identical to Walmart and Best Buy
    this.searchQueries = config.searchQueries || SEARCH_QUERIES;
  }

  _deriveTiming() {
    this.discoveryIntervalMs = this.timingValue('discoveryIntervalMs', DISCOVERY_INTERVAL_DEFAULT, DISCOVERY_INTERVAL_FLOOR);
    // The AOD offer sweep is throttled hard by Amazon, so it runs far less often than search
    this.aodSweepIntervalMs = this.timingValue('aodSweepIntervalMs', 5 * 60 * 1000, 60 * 1000);
  }

  /**
   * Check one ASIN through Amazon's All-Offers-Display AJAX endpoint.
   *
   * This is the same trick that fixed Walmart: the full /dp/ page is ~1.9 MB and is
   * currently served as a 3.7 KB "continue shopping" interstitial anyway, while AOD
   * returns ~30 KB of exactly what we need — title, price, seller, offer listing id —
   * and is not gated. 15 ASINs every 2 minutes drops from ~20 GB/day to ~0.3 GB/day,
   * and the offer id it hands back saves the 10-credit enrichment call per alert.
   */
  async _stealthCheckAsin(asin) {
    const url = `https://www.amazon.ca/gp/product/ajax/aodAjaxMain/?asin=${asin}&pc=dp`;
    const proxyUrl = getProxyUrl('residential');

    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 12000,
        rawHeaders: true,
        headers: {
          'Accept': 'text/html,*/*;q=0.8',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': `https://www.amazon.ca/dp/${asin}`,
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      this._lastFetchThrottled = false;
      // Amazon answers an over-used AOD endpoint with a 503 that redirects to /error/500
      if (html && html.includes('/error/500')) {
        this._lastFetchThrottled = true;
        return null;
      }
      if (!html || html.length < 1000) return null;
      if (html.includes('Click the button below to continue shopping')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      // Bot detection / CAPTCHA pages
      if (html.includes('Robot Check') || html.includes('captcha') ||
          html.includes('Type the characters') || html.includes('Sorry, we just need to make sure')) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }

      return this._parseAod(html, asin);
    } catch (err) {
      // stealthGet throws on 503 before we can read the body
      this._lastFetchThrottled = /50[03]|Blocked after/.test(err.message || '');
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  /**
   * Parse the AOD fragment. No offer block at all means nobody is selling it — that is
   * a genuine out-of-stock, not a parse failure, so it returns a result rather than null.
   */
  _parseAod(html, asin) {
    const titleMatch = html.match(/id="aod-asin-title-text"[^>]*>\s*([^<]+?)\s*</);
    const name = titleMatch ? decodeEntities(titleMatch[1].trim()) : null;

    // Buy-box offer id — doubles as the "is anything purchasable" signal
    const olidMatch = html.match(/name="items\[0\.base\]\[offerListingId\]"\s*value="([^"]+)"/);
    const olid = olidMatch ? decodeURIComponent(olidMatch[1]) : null;

    let price = null;
    const apexPrice = html.match(/apex-pricetopay-accessibility-label"[^>]*>\s*\$?([\d,]+\.\d{2})/);
    if (apexPrice) price = normalizePrice(apexPrice[1]);
    if (!price) {
      const whole = html.match(/class="a-price-whole">\s*([\d,]+)/);
      const frac = html.match(/class="a-price-fraction">(\d+)/);
      if (whole) price = parseFloat(`${whole[1].replace(/,/g, '')}.${frac ? frac[1] : '00'}`);
    }

    // "Sold by" is a label/value pair; the value is the next a-color-base span after it
    let seller = null;
    const soldByIdx = html.indexOf('aod-offer-soldBy');
    if (soldByIdx !== -1) {
      const block = html.slice(soldByIdx, soldByIdx + 900);
      const linked = block.match(/<a[^>]*>\s*([^<]{2,60}?)\s*<\/a>/);
      const plain = block.match(/a-color-base[^>]*>\s*([^<]{2,60}?)\s*</);
      seller = decodeEntities((linked ? linked[1] : plain ? plain[1] : '').trim()) || null;
    }

    const imgMatch = html.match(/id="aod-asin-image-id"[^>]*src="([^"]+)"/)
      || html.match(/src="([^"]+)"[^>]*id="aod-asin-image-id"/);

    const inStock = !!olid && price != null;
    if (!name && !inStock) return null; // nothing parsed at all — treat as a failed fetch

    return { asin, name, price, inStock, image: imgMatch ? imgMatch[1] : '', olid, seller };
  }

  /**
   * Search runs every poll and is now the detection path: it is free, and it reports a
   * brand-new listing the same cycle it appears rather than up to 30 minutes later.
   * The AOD sweep only tops up offer ids and sellers, and only when Amazon is not
   * throttling it — search alone is enough to fire a restock alert.
   */
  async fetchProducts() {
    const products = {};
    const now = Date.now();

    // Amazon throttles by endpoint, as the AOD sweep found out the hard way. If search
    // starts failing, slow down rather than hammering it into a deeper block.
    const rate = this._searchSuccessRate();
    if (rate !== null && rate < 0.5 && ++this._searchSkip % 2 !== 0) {
      logger.warn(`Amazon: search backing off (${Math.round(rate * 100)}% success) — skipping cycle`);
      for (const [asin, cached] of this._knownProducts) products[asin] = cached;
      return products;
    }

    await this._runDiscovery(products);

    // Prune anything unseen for 24h so a delisted ASIN does not linger forever
    for (const [asin, data] of this._knownProducts) {
      if (!(asin in products) && (now - (data.lastSeen || 0)) > 24 * 60 * 60 * 1000) {
        this._knownProducts.delete(asin);
      }
    }

    // Back off the enrichment sweep while search is struggling — they share a pool
    const searchRate = this._searchSuccessRate();
    if (now - this._lastAodSweepAt >= this.aodSweepIntervalMs && (searchRate ?? 1) >= 0.5) {
      this._lastAodSweepAt = now;
      await this._monitorKnownAsins(products);
    }

    return products;
  }

  /**
   * Discovery: free search for new products and their current stock.
   */
  async _runDiscovery(products) {
    const results = await Promise.allSettled(
      this.searchQueries.map(query => this._freeSearch(query).then(items => ({ query, items })))
    );

    let hits = 0;
    let found = 0;
    for (const result of results) {
      if (result.status === 'rejected') continue;
      const { items } = result.value;
      if (!items || items.length === 0) continue;
      hits++;
      found += items.length;
      for (const item of items) {
        const product = this._buildFromSearch(item, result.value.query);
        if (!product) continue;
        products[product.sku] = product;
        this._knownProducts.set(product.sku, product);
      }
    }

    // Carry forward anything this sweep did not surface — absence from a search page is
    // not evidence of going out of stock
    for (const [asin, cached] of this._knownProducts) {
      if (!(asin in products)) products[asin] = cached;
    }

    this._recordSearchResult(hits, this.searchQueries.length);
    this.reportFreshness(hits, this.searchQueries.length);
    logger.info(`Amazon: SEARCH — ${hits}/${this.searchQueries.length} queries, ${found} results, ${this._knownProducts.size} known ASINs ($0)`);
  }

  /**
   * Free search against amazon.ca. The old path spent 5 ScraperAPI credits per query and
   * so could only run every 30 minutes, which meant a brand-new listing went unnoticed
   * for up to half an hour. Plain search returns ASIN, title, price and stock for ~40
   * products per query and is not gated, so this can run on every poll for nothing.
   */
  async _freeSearch(query) {
    const url = `https://www.amazon.ca/s?k=${encodeURIComponent(query)}&i=toys`;
    // A search page is ~1.4MB. Four of them every 10s through the residential proxy would
    // be ~48GB/day, so the proxy is the fallback, not the default — direct also answers
    // in ~1.2s versus ~3.5s proxied.
    const direct = await this._searchOnce(url, null);
    if (direct) return direct;
    return this._searchOnce(url, getProxyUrl('residential'));
  }

  async _searchOnce(url, proxyUrl) {
    try {
      const html = await stealthGet(url, {
        proxyUrl,
        maxRetries: 1,
        timeoutMs: 12000,
        rawHeaders: true,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Upgrade-Insecure-Requests': '1',
        },
      });
      if (!html || html.length < 50000) return null;
      if (/api-services-support|Type the characters|continue shopping/.test(html)) {
        if (proxyUrl) _clearCache(proxyUrl);
        return null;
      }
      return this._parseSearchHtml(html);
    } catch {
      if (proxyUrl) _clearCache(proxyUrl);
      return null;
    }
  }

  _parseSearchHtml(html) {
    const cards = html.split('data-component-type="s-search-result"').slice(1);
    const out = [];
    for (const card of cards) {
      const asin = (card.match(/data-csa-c-item-id="amzn1\.asin\.([A-Z0-9]{10})"/) || [])[1];
      if (!asin) continue;
      const name = (card.match(/<h2[^>]*aria-label="([^"]{8,200})"/) || [])[1];
      if (!name) continue;
      // Scope the price to the card's OWN price block. A card's slice routinely contains
      // prices belonging to other ASINs — sponsored placements and related-item strips render
      // inside the result grid — so taking the first a-offscreen in the slice read a
      // neighbour's price. It was worst on cards with no price of their own (a genuinely
      // unavailable item), where the parser would reach past the product entirely and invent
      // one: B0GW2DK37Q has no price on the card, and successive polls attributed $15.99,
      // $147.00, $39.95 and $24.69 to it, each from whichever neighbour happened to be next.
      // Verified against a live page: where a real price exists this agrees 27/27.
      const priceStr = (card.match(/data-cy="price-recipe"[\s\S]{0,1200}?a-offscreen">\$([\d,]+\.\d{2})/) || [])[1];
      const price = priceStr ? normalizePrice(priceStr) : null;
      // A search card only shows a price when the item is buyable
      const oos = /Currently unavailable|Temporarily out of stock/i.test(card);
      out.push({
        asin,
        name: decodeEntities(name.trim()),
        price,
        inStock: !!price && !oos,
        image: (card.match(/<img[^>]+src="(https:\/\/m\.media-amazon\.com[^"]+)"/) || [])[1] || '',
      });
    }
    return out;
  }

  /**
   * Amazon truncates search titles and often drops the franchise word — "TCG: First
   * Partner Illustration Collection" is a Pokemon product with nothing in the name to
   * say so, and would classify as "other" and never alert. The query that returned it
   * is the reliable signal, so it supplies the category when the title cannot.
   */
  _buildFromSearch(item, query) {
    if (!item.name || !item.asin) return null;
    const lower = item.name.toLowerCase();
    if (ACCESSORY_KEYWORDS.some(k => lower.includes(k))) return null;
    if (!isTCGProduct(item.name)) return null;
    // A title naming a game we do not track is a genuine miss, not a truncation
    if (/yu-?gi-?oh|magic the gathering|\bmtg\b|lorcana|digimon|dragon ball/i.test(item.name)) return null;

    const cached = this._knownProducts.get(item.asin) || {};
    const product = this.classify({
      ...cached,
      sku: item.asin,
      name: item.name,
      price: item.price ?? cached.price ?? 0,
      currency: 'CAD',
      url: `https://www.amazon.ca/dp/${item.asin}`,
      image: item.image || cached.image || '',
      inStock: item.inStock,
      canAddToCart: item.inStock,
      shipsToHome: true,
      lastSeen: Date.now(),
    });

    if (product.category === 'other' && query) {
      product.category = /one piece/i.test(query) ? 'onepiece' : 'pokemon';
      product._categoryFromQuery = true;
    }
    return product;
  }

  _recordSearchResult(hits, total) {
    if (!total) return;
    this._searchWindow.push(hits / total);
    if (this._searchWindow.length > 10) this._searchWindow.shift();
  }

  _searchSuccessRate() {
    if (this._searchWindow.length < 3) return null;
    return this._searchWindow.reduce((a, b) => a + b, 0) / this._searchWindow.length;
  }

  /**
   * Monitor: check known ASINs via the AOD offer endpoint (FREE).
   * Returns cached data for ASINs where the fetch fails (prevents false OOS).
   */
  async _monitorKnownAsins(products) {
    const asins = [...this._knownProducts.keys()];
    if (asins.length === 0) {
      logger.debug('Amazon: no known ASINs — waiting for discovery');
      return;
    }

    // AOD is cheap per request but Amazon throttles it per-endpoint: 12 ASINs in ~7s
    // earned a 503 redirect to /error/500 on every call, direct and proxied alike.
    // Pairs with a wide gap keep the same 2-minute cadence well inside the limit.
    if (Date.now() < this._aodCooldownUntil) {
      const waitSec = Math.round((this._aodCooldownUntil - Date.now()) / 1000);
      logger.warn(`Amazon: MONITOR skipped — AOD throttled, retrying in ${waitSec}s`);
      for (const [asin, cached] of this._knownProducts) products[asin] = cached;
      return;
    }

    // Measured ceiling: sequential at ~0.5 req/s passes (5/5), two concurrent at ~1.3 req/s
    // fails (7/8 x 503) — and a fresh residential IP per request does not change that, so
    // the throttle is endpoint-wide rather than per-IP. One at a time it is.
    let checked = 0;
    let updated = 0;
    let throttled = 0;
    const BATCH = 1;

    for (let i = 0; i < asins.length; i += BATCH) {
      const batch = asins.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(asin => this._stealthCheckAsin(asin).then(data => ({ asin, data })))
      );

      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { asin, data } = result.value;
        checked++;

        if (data) {
          updated++;
          const cached = this._knownProducts.get(asin);

          // AOD hands us the offer listing id and seller for free. Caching them here is
          // what stops delivery.enrichEvent paying 10 ScraperAPI credits per alert.
          if (data.olid || data.seller) {
            state.cacheOfferListingId(asin, data.olid).catch(() => {});
            if (data.seller) state.cacheSellerInfo(asin, data.seller).catch(() => {});
          }

          // Keep cached identity (name, category, retailer) — update price + stock only
          const product = {
            ...cached,
            price: data.price || cached.price,
            inStock: data.inStock,
            canAddToCart: data.inStock,
            image: data.image || cached.image,
            lastSeen: Date.now(),
          };
          this._knownProducts.set(asin, product);
          products[asin] = product;
        } else {
          // Fetch failed — return cached data unchanged (no false OOS events)
          if (this._lastFetchThrottled) throttled++;
          const cached = this._knownProducts.get(asin);
          if (cached) products[asin] = cached;
        }
      }

      // Back off the whole pass as soon as Amazon starts throttling, rather than
      // walking the rest of the list into the same wall
      if (throttled >= 2) {
        this._aodCooldownUntil = Date.now() + AOD_COOLDOWN_MS;
        logger.warn(`Amazon: AOD throttled (${throttled} x 503) — pausing the monitor for ${AOD_COOLDOWN_MS / 60000}min`);
        for (const [asin, cached] of this._knownProducts) {
          if (!(asin in products)) products[asin] = cached;
        }
        break;
      }

      if (i + BATCH < asins.length) {
        const px = getProxyUrl('residential');
        if (px) _clearCache(px);
        await sleep(1600 + Math.floor(Math.random() * 600));
      }
    }

    this.reportFreshness(updated, checked);
    this._monitorSuccessRate = checked > 0 ? Math.round((updated / checked) * 100) : 0;
    logger.info(`Amazon: MONITOR — ${updated}/${checked} ASINs updated (free stealth). ${this._monitorSuccessRate}% success.${throttled ? ` ${throttled} throttled.` : ''}`);
  }

  /**
   * Fetch a single product page — used by watchlist fast-polling.
   */
  async fetchProductPage(asin) {
    const data = await this._stealthCheckAsin(asin);
    if (!data) return null;

    // Apply game name + TCG filters
    const lowerName = data.name.toLowerCase();
    const hasGameName = GAME_NAMES.some(g => lowerName.includes(g));
    if (!hasGameName) return null;
    if (!isTCGProduct(data.name)) return null;

    return this.classify({
      sku: asin,
      name: data.name,
      price: data.price,
      currency: 'CAD',
      url: `https://www.amazon.ca/dp/${asin}`,
      image: data.image || '',
      inStock: data.inStock,
      canAddToCart: data.inStock,
      shipsToHome: true,
    });
  }

  /**
   * Process search result items into classified products.
   * Used by discovery (ScraperAPI JSON results).
   * Applies all 5 filter layers: game name, TCG product, accessory, seller, price.
   */
  _processSearchItems(items, products) {
    for (const item of items) {
      try {
        const asin = item.asin || item.ASIN;
        if (!asin) continue;

        const name = item.name || item.title;
        if (!name) continue;

        const lowerName = name.toLowerCase();

        // Layer 1: Must mention a game we actually track
        const hasGameName = GAME_NAMES.some(g => lowerName.includes(g));
        if (!hasGameName) continue;

        // Layer 2: Must pass shared TCG product filter (sealed products, not figures/toys)
        if (!isTCGProduct(name)) continue;

        // Layer 3: Exclude accessories (deck boxes, binders, sleeves, etc.)
        const isAccessory = ACCESSORY_KEYWORDS.some(kw => lowerName.includes(kw));
        if (isAccessory) continue;

        // Layer 4: emi= URL filter restricts to "sold by Amazon.ca" at search level.
        // Double-check if seller data is present.
        const seller = (item.sold_by || item.seller || '').toLowerCase();
        if (seller && !seller.includes('amazon')) continue;

        const price = typeof item.price === 'number' ? item.price :
          normalizePrice(item.price_string || item.price || item.current_price);

        // Layer 5: Must have a real price
        if (price == null || price <= 0) continue;

        const url = item.url || item.product_url || item.link ||
          `https://www.amazon.ca/dp/${asin}`;
        const fullUrl = url.startsWith('http') ? url : `https://www.amazon.ca${url}`;

        const image = item.image || item.thumbnail || '';
        const inStock = true;

        const product = this.classify({
          sku: asin,
          name,
          price,
          currency: 'CAD',
          url: fullUrl,
          image,
          inStock,
          canAddToCart: inStock,
          shipsToHome: true,
        });

        products[product.sku] = product;
      } catch (err) {
        logger.debug(`Amazon: failed to parse item: ${err.message}`);
      }
    }
  }
}

module.exports = AmazonAdapter;
