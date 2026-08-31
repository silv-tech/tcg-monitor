const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');

class PokemonCenterAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.sitemapUrl = 'https://www.pokemoncenter.com/sitemaps/products.xml';
    // TCG sealed product keywords for filtering sitemap URLs
    this.tcgKeywords = [
      'pokemon-tcg-', '-tcg-',
      'booster-box', 'booster-bundle', 'elite-trainer-box',
      'collection-box', 'special-collection', 'premium-collection',
      'build-and-battle', 'league-battle-deck', 'ultra-premium',
      'poster-collection', 'tech-sticker-collection',
      'combined-powers', 'super-premium',
      'scarlet-violet', 'prismatic-evolutions',
      'surging-sparks', 'stellar-crown', 'twilight-masquerade',
      'shrouded-fable', 'paldean-fates', 'paradox-rift',
      'temporal-forces', 'obsidian-flames', 'paldea-evolved',
      'astral-radiance', 'brilliant-stars', 'lost-origin',
      'silver-tempest', 'crown-zenith',
    ];
  }

  async fetchProducts() {
    const products = {};

    // Fetch the products sitemap — this endpoint has lighter DataDome protection
    let xml;
    try {
      xml = await this.stealthFetch(this.sitemapUrl, { timeoutMs: 30000 });
    } catch (stealthErr) {
      logger.info(`Pokemon Center: stealth sitemap failed (${stealthErr.message}), trying browser`);
      xml = await this.browserFetch(this.sitemapUrl, { timeoutMs: 45000 });
    }

    // Verify we got actual XML, not a challenge page
    if (!xml.includes('<loc>') || xml.includes('Pardon Our Interruption')) {
      throw new Error('Sitemap returned challenge page — DataDome blocking');
    }

    // Parse product URLs from sitemap
    const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];

    for (const match of urlMatches) {
      try {
        const url = match.replace(/<\/?loc>/g, '');
        if (!url.includes('/product/')) continue;

        const parts = url.split('/');
        const slug = parts[parts.length - 1] || '';
        const sku = parts[parts.length - 2] || '';

        if (!sku || !slug) continue;

        // Filter for TCG-related products
        const lowerSlug = slug.toLowerCase();
        const isTcg = this.tcgKeywords.some(kw => lowerSlug.includes(kw));
        if (!isTcg) continue;

        // Convert slug to readable name
        const name = slug
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        const product = this.classify({
          sku,
          name,
          price: null, // Sitemap doesn't include prices
          currency: 'CAD',
          url: url.includes('/en-ca/') ? url : url.replace('/product/', '/en-ca/product/'),
          image: '',
          inStock: true, // Present in sitemap = listed on site
          canAddToCart: true,
          shipsToHome: true,
        });

        products[product.sku] = product;
      } catch (err) {
        // Skip malformed URLs
      }
    }

    if (Object.keys(products).length === 0) {
      throw new Error('Sitemap parsed 0 TCG products — may be blocked or format changed');
    }

    logger.info(`Pokemon Center: ${Object.keys(products).length} TCG products from sitemap (${urlMatches.length} total URLs)`);
    return products;
  }
}

module.exports = PokemonCenterAdapter;
