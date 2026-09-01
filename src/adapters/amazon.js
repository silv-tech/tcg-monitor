const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const { normalizePrice, isTCGProduct } = require('../utils/helpers');
const { amazonSearch, isConfigured } = require('../utils/scraper-api');

// Game names that we track — Amazon results MUST match one of these
const GAME_NAMES = [
  'pokemon', 'pokémon', 'one piece', 'dragon ball', 'lorcana',
  'yugioh', 'yu-gi-oh', 'magic the gathering', 'digimon',
  'naruto', 'star wars unlimited', 'flesh and blood', 'union arena',
  'weiss schwarz', 'cardfight vanguard',
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

class AmazonAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.domain = 'www.amazon.ca';
    // Search queries — autoparse with emi= filter ensures "sold by Amazon" only
    this.searchQueries = [
      // Pokemon (highest demand — multiple queries for coverage)
      'pokemon tcg booster box',
      'pokemon elite trainer box',
      'pokemon tcg collection box',
      'pokemon tcg sealed',
      'pokemon tcg preorder',
      'pokemon tcg booster bundle',
      'pokemon tcg ultra premium collection',
      // Other TCGs
      'one piece card game booster box',
      'dragon ball super card game booster box',
      'yu-gi-oh booster box',
      'lorcana booster box',
      'magic the gathering booster box',
      'digimon card game booster box',
      'flesh and blood tcg booster box',
      'weiss schwarz booster box',
      'cardfight vanguard booster box',
      'union arena booster box',
      'star wars unlimited booster box',
      'naruto boruto card game',
    ];
  }

  async fetchProducts() {
    if (!isConfigured()) {
      throw new Error('Amazon: SCRAPER_API_KEY not configured — structured endpoint required');
    }

    const products = {};

    // Parallel search queries (#6) — all queries fire simultaneously
    const searchResults = await Promise.allSettled(
      this.searchQueries.map(query =>
        amazonSearch(query, { retailerId: this.id })
          .then(data => ({ query, data }))
      )
    );

    for (const result of searchResults) {
      if (result.status === 'rejected') {
        logger.warn(`Amazon: structured search failed: ${result.reason.message}`);
        continue;
      }
      const { query, data } = result.value;
      if (!data) {
        logger.debug(`Amazon: rate-limited for "${query}"`);
        continue;
      }

      // Autoparse returns results in various field names — try all known variants
      const results = data.results || data.organic_results || data.search_results ||
        data.items || data.ads || [];
      if (results.length === 0) {
        // Log top-level keys to help debug response format
        logger.warn(`Amazon: 0 results for "${query}" (keys: ${Object.keys(data).join(', ')})`);
        continue;
      }

      for (const item of results) {
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

          // Layer 4: emi= URL filter already restricts to "sold by Amazon.ca" at search level.
          // Double-check if seller data is present in autoparse response.
          const seller = (item.sold_by || item.seller || '').toLowerCase();
          if (seller && !seller.includes('amazon')) continue;

          const price = typeof item.price === 'number' ? item.price :
            normalizePrice(item.price_string || item.price || item.current_price);

          // Layer 5: Must have a real price — no-price listings are placeholder/third-party junk
          if (price == null || price <= 0) continue;

          const url = item.url || item.product_url || item.link ||
            `${this.url}/dp/${asin}`;
          const fullUrl = url.startsWith('http') ? url : `${this.url}${url}`;

          const image = item.image || item.thumbnail || '';
          const inStock = true; // If it passed the price check, it's purchasable

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

      logger.info(`Amazon: "${query}" returned ${results.length} results, ${Object.keys(products).length} total products`);
    }

    return products;
  }
}

module.exports = AmazonAdapter;
