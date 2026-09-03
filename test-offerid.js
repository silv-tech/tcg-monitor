/**
 * Test: Fire a Walmart alert with Offer ID enrichment.
 * Run on Railway (needs residential proxy for offerId fetch).
 */
require('dotenv').config();
const delivery = require('./src/discord/delivery');
const logger = require('./src/monitoring/logger');

(async () => {
  // Wait for Redis connection
  const state = require('./src/core/state');
  await new Promise(r => setTimeout(r, 2000));

  const event = {
    type: 'RESTOCK',
    product: {
      sku: '66WBIOXIU4UC',
      name: 'Pokémon TCG: Charizard ex Special Collection',
      price: 69.98,
      currency: 'CAD',
      url: 'https://www.walmart.ca/en/ip/Pok-mon-TCG-Charizard-ex-Special-Collection/66WBIOXIU4UC',
      image: '',
      inStock: true,
      canAddToCart: true,
      shipsToHome: true,
      retailer: 'Walmart Canada',
      retailerId: 'walmart',
      category: 'pokemon',
      isTCG: true,
    },
    detail: 'TEST: Walmart alert with Offer ID enrichment',
    _detectedAt: Date.now(),
    _scanTier: 'scan', // bypass filters for test
  };

  logger.info('Firing test Walmart alert (will enrich offerId via stealth fetch)...');
  await delivery.deliver([event], { skipDedup: true });
  logger.info('Test alert sent. Check Discord.');

  // Give delivery time to process
  await new Promise(r => setTimeout(r, 15000));
  process.exit(0);
})().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
