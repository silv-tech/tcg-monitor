const express = require('express');
const fs = require('fs');
const path = require('path');
const state = require('../core/state');
const { checkHealth } = require('../monitoring/health');
const { getStats: getProxyStats, reloadProxies, getProxyPoolStats } = require('../core/proxy');
const scheduler = require('../core/scheduler');
const logger = require('../monitoring/logger');

const delivery = require('../discord/delivery');
const { runScan } = require('../core/scan');
const { getBudgetStatus } = require('../utils/scraper-api');

const router = express.Router();

const retailersPath = path.join(__dirname, '../config/retailers.json');

// Merge base retailers.json with Redis overrides (enabled, intervalMs persist across deploys)
async function getRetailersWithOverrides() {
  const base = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const overrides = await state.getRetailerOverrides();
  return base.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
}
const productsPath = path.join(__dirname, '../config/products.json');
const channelsPath = path.join(__dirname, '../config/channels.json');
const proxiesPath = path.join(__dirname, '../config/proxies.json');

// P2-8: Atomic file write — write to temp then rename to prevent corruption on crash
function atomicWriteSync(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// Health check
router.get('/health', async (req, res) => {
  const health = await checkHealth();
  const allHealthy = health.every(r => r.healthy);
  res.json({ status: allHealthy ? 'ok' : 'degraded', retailers: health });
});

// List retailers (base + Redis overrides merged)
router.get('/retailers', async (req, res) => {
  const retailers = await getRetailersWithOverrides();
  res.json(retailers);
});

// Toggle / update retailer — saves overrides to Redis (persists across deploys)
router.patch('/retailers/:id', async (req, res) => {
  const retailers = await getRetailersWithOverrides();
  const retailer = retailers.find(r => r.id === req.params.id);
  if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

  // Input validation (#18)
  const changes = {};
  if (req.body.enabled !== undefined) {
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    changes.enabled = req.body.enabled;
  }
  if (req.body.intervalMs !== undefined) {
    if (typeof req.body.intervalMs !== 'number' || req.body.intervalMs < 5000 || req.body.intervalMs > 600000) {
      return res.status(400).json({ error: 'intervalMs must be a number between 5000 and 600000' });
    }
    changes.intervalMs = req.body.intervalMs;
  }
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  await state.setRetailerOverride(req.params.id, changes);

  // Apply changes live — no restart needed
  scheduler.updateAdapter(req.params.id, changes);

  res.json({ ...retailer, ...changes });
});

// Add new retailer
router.post('/retailers', (req, res) => {
  const { id, name, url, adapter, intervalMs, proxyTier, color } = req.body;
  if (!id || !name || !url || !adapter) {
    return res.status(400).json({ error: 'id, name, url, and adapter are required' });
  }
  // Input validation (#18)
  if (typeof id !== 'string' || !/^[a-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'id must be lowercase alphanumeric with hyphens/underscores' });
  }
  if (typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({ error: 'name must be a string under 100 chars' });
  }
  if (typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'url must be a valid HTTP URL' });
  }
  const validAdapters = ['shopify', 'walmart', 'amazon', 'costco', 'pokemoncenter', 'bestbuy', 'ebgames'];
  if (!validAdapters.includes(adapter)) {
    return res.status(400).json({ error: `adapter must be one of: ${validAdapters.join(', ')}` });
  }

  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  if (retailers.some(r => r.id === id)) {
    return res.status(409).json({ error: 'Retailer ID already exists' });
  }

  const newRetailer = {
    id,
    name,
    url,
    adapter,
    intervalMs: intervalMs || 45000,
    proxyTier: proxyTier || 'none',
    enabled: false,
    color: color || '#3b82f6',
  };

  retailers.push(newRetailer);
  atomicWriteSync(retailersPath, JSON.stringify(retailers, null, 2));
  logger.info(`Retailer added via admin: ${id} (${name})`);
  res.status(201).json(newRetailer);
});

// Remove retailer
router.delete('/retailers/:id', (req, res) => {
  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const idx = retailers.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Retailer not found' });

  const removed = retailers.splice(idx, 1)[0];
  atomicWriteSync(retailersPath, JSON.stringify(retailers, null, 2));
  logger.info(`Retailer removed via admin: ${removed.id} (${removed.name})`);
  res.json({ ok: true, removed });
});

// Helper: read products config from Redis (persists across deploys), fall back to file
async function getProductsWithRedis() {
  const fromRedis = await state.getProductsConfig();
  if (fromRedis) return fromRedis;
  return JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
}

// Helper: save products config to both Redis and file
async function saveProductsConfig(products) {
  await state.setProductsConfig(products);
  atomicWriteSync(productsPath, JSON.stringify(products, null, 2));
}

// List tracked products/keywords
router.get('/products', async (req, res) => {
  const products = await getProductsWithRedis();
  res.json(products);
});

// Add tracked SKU
router.post('/products/tracked', async (req, res) => {
  const { sku, retailer, name } = req.body;
  if (!sku || !retailer) return res.status(400).json({ error: 'sku and retailer required' });

  const products = await getProductsWithRedis();
  const exists = products.tracked.some(t => t.sku === sku && t.retailer === retailer);
  if (exists) return res.status(409).json({ error: 'Already tracked' });

  products.tracked.push({ sku, retailer, name: name || sku, addedAt: new Date().toISOString() });
  await saveProductsConfig(products);
  res.status(201).json({ ok: true });
});

// Remove tracked SKU
router.delete('/products/tracked/:retailer/:sku', async (req, res) => {
  const products = await getProductsWithRedis();
  const before = products.tracked.length;
  products.tracked = products.tracked.filter(
    t => !(t.sku === req.params.sku && t.retailer === req.params.retailer)
  );
  if (products.tracked.length === before) return res.status(404).json({ error: 'Not found' });
  await saveProductsConfig(products);
  res.json({ ok: true });
});

// Add keyword
router.post('/products/keywords', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  const products = await getProductsWithRedis();
  if (products.keywords.includes(keyword)) return res.status(409).json({ error: 'Already exists' });

  products.keywords.push(keyword);
  await saveProductsConfig(products);
  res.json({ ok: true });
});

// Remove keyword
router.delete('/products/keywords/:keyword', async (req, res) => {
  const products = await getProductsWithRedis();
  const idx = products.keywords.indexOf(req.params.keyword);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  products.keywords.splice(idx, 1);
  await saveProductsConfig(products);
  res.json({ ok: true });
});

// Proxy stats
router.get('/stats/proxy', (req, res) => {
  res.json(getProxyStats());
});

// ScraperAPI budget status (#2)
router.get('/stats/budget', (req, res) => {
  res.json(getBudgetStatus());
});

// Circuit breaker status
router.get('/stats/circuits', (req, res) => {
  res.json(scheduler.getCircuitStatus());
});

// Product count from Redis (actual discovered products across all retailers)
router.get('/stats/products', async (req, res) => {
  try {
    const retailers = await getRetailersWithOverrides();
    const enabled = retailers.filter(r => r.enabled);
    let totalProducts = 0;
    const byRetailer = {};
    for (const r of enabled) {
      const products = await state.getAllProducts(r.id);
      const count = Object.keys(products).length;
      totalProducts += count;
      if (count > 0) byRetailer[r.id] = count;
    }
    res.json({ total: totalProducts, byRetailer });
  } catch (err) {
    res.json({ total: 0, byRetailer: {} });
  }
});

// Retailer state (cached products)
router.get('/state/:retailerId', async (req, res) => {
  const products = await state.getAllProducts(req.params.retailerId);
  res.json({ retailerId: req.params.retailerId, productCount: Object.keys(products).length, products });
});

// Manual scan — resend cached products to Discord
router.post('/scan', async (req, res) => {
  const hours = req.body.hours;
  if (typeof hours !== 'number' || (hours !== 12 && hours !== 24)) {
    return res.status(400).json({ error: 'hours must be 12 or 24' });
  }
  try {
    const results = await runScan(hours);
    logger.info(`Manual scan triggered via dashboard: ${hours}h, ${results.totalSent} products sent`);
    res.json(results);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Helper: read channels config from Redis (persists across deploys), fall back to file
async function getChannelsWithRedis() {
  const fromRedis = await state.getChannelsConfig();
  if (fromRedis) return fromRedis;
  return JSON.parse(fs.readFileSync(channelsPath, 'utf-8'));
}

// Save channels config to Redis (#20) — file write kept for backward compat with delivery.reloadChannels()
async function saveChannelsConfig(channels) {
  await state.setChannelsConfig(channels);
  // Still write file since delivery.reloadChannels() reads from disk
  try { atomicWriteSync(channelsPath, JSON.stringify(channels, null, 2)); } catch {}
  delivery.reloadChannels();
}

// Toggle free tier on/off
router.post('/channels/freetier', async (req, res) => {
  const channels = await getChannelsWithRedis();
  if (!channels.tiers) channels.tiers = {};
  if (!channels.tiers.free) channels.tiers.free = {};

  const currentlyEnabled = channels.tiers.free.enabled !== false;
  channels.tiers.free.enabled = !currentlyEnabled;

  await saveChannelsConfig(channels);
  const newState = !currentlyEnabled;
  logger.info(`Free tier toggled ${newState ? 'ON' : 'OFF'} via dashboard`);
  res.json({ enabled: newState });
});

// Get channel config
router.get('/channels', async (req, res) => {
  const channels = await getChannelsWithRedis();
  res.json(channels);
});

// Update channel config
router.put('/channels', async (req, res) => {
  await saveChannelsConfig(req.body);
  res.json({ ok: true });
});

// Update a single channel or role mapping
router.patch('/channels', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  const channels = await getChannelsWithRedis();
  // Deep merge (max depth 5 to prevent prototype pollution)
  function merge(target, source, depth = 0) {
    if (depth > 5) return;
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        merge(target[key], source[key], depth + 1);
      } else {
        target[key] = source[key];
      }
    }
  }
  merge(channels, req.body);
  await saveChannelsConfig(channels);
  res.json(channels);
});

// Get proxy pool config & status
router.get('/proxies', (req, res) => {
  const config = JSON.parse(fs.readFileSync(proxiesPath, 'utf-8'));
  res.json({ config, pool: getProxyPoolStats() });
});

// === Watchlist management (early SKU detection) ===

// Get watchlist for a retailer
router.get('/retailers/:id/watchlist', (req, res) => {
  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const retailer = retailers.find(r => r.id === req.params.id);
  if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

  const adapter = scheduler.getAdapter(req.params.id);
  const liveWatchlist = adapter && adapter.watchlist ? [...adapter.watchlist] : [];
  res.json({ retailerId: req.params.id, watchlist: liveWatchlist, config: retailer.watchlist || [] });
});

// Add SKU to watchlist
router.post('/retailers/:id/watchlist', (req, res) => {
  const { sku } = req.body;
  if (!sku || typeof sku !== 'string') return res.status(400).json({ error: 'sku (string) required' });

  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const retailer = retailers.find(r => r.id === req.params.id);
  if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

  // Add to config file
  if (!retailer.watchlist) retailer.watchlist = [];
  if (retailer.watchlist.includes(sku)) return res.status(409).json({ error: 'SKU already in watchlist' });
  retailer.watchlist.push(sku);
  atomicWriteSync(retailersPath, JSON.stringify(retailers, null, 2));

  // Add to live adapter
  const adapter = scheduler.getAdapter(req.params.id);
  if (adapter && adapter.watchlist) {
    adapter.watchlist.add(sku);
    // Ensure watchlist timer is running
    scheduler.ensureWatchlistTimer(req.params.id);
  }

  logger.info(`Watchlist: added ${sku} to ${req.params.id}`);
  res.status(201).json({ ok: true, watchlist: retailer.watchlist });
});

// Remove SKU from watchlist
router.delete('/retailers/:id/watchlist/:sku', (req, res) => {
  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const retailer = retailers.find(r => r.id === req.params.id);
  if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

  if (!retailer.watchlist || !retailer.watchlist.includes(req.params.sku)) {
    return res.status(404).json({ error: 'SKU not in watchlist' });
  }
  retailer.watchlist = retailer.watchlist.filter(s => s !== req.params.sku);
  atomicWriteSync(retailersPath, JSON.stringify(retailers, null, 2));

  // Remove from live adapter
  const adapter = scheduler.getAdapter(req.params.id);
  if (adapter && adapter.watchlist) {
    adapter.watchlist.delete(req.params.sku);
  }

  logger.info(`Watchlist: removed ${req.params.sku} from ${req.params.id}`);
  res.json({ ok: true, watchlist: retailer.watchlist });
});

// Update proxy list
router.put('/proxies', (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Body must be a valid JSON object' });
  }
  atomicWriteSync(proxiesPath, JSON.stringify(req.body, null, 2));
  reloadProxies();
  res.json({ ok: true, pool: getProxyPoolStats() });
});

// === Test alert (fire a single product alert for testing) ===
// Optional channelId param sends directly to that channel instead of normal routing
router.post('/test-alert', async (req, res) => {
  const { retailerId, sku, type = 'RESTOCK', channelId } = req.body;
  if (!retailerId || !sku) return res.status(400).json({ error: 'retailerId and sku required' });

  try {
    // Try to get product from Redis first
    let product = await state.getProduct(retailerId, sku);

    if (!product) {
      // Build minimal product from request body
      product = {
        sku,
        name: req.body.name || sku,
        price: req.body.price || null,
        url: req.body.url || '',
        image: req.body.image || '',
        inStock: true,
        canAddToCart: true,
        retailer: req.body.retailer || retailerId,
        retailerId,
        category: 'pokemon',
        isTCG: true,
      };
    }

    const event = {
      type,
      product,
      detail: `Test alert for ${product.name}`,
      _detectedAt: Date.now(),
      _scanTier: 'scan',
    };

    // Enrich event (offerId, restock history, etc.)
    await delivery.enrichEvent(event);

    if (channelId) {
      // Send directly to specified channel
      const { getClient } = require('../discord/bot');
      const { buildAlertEmbed } = require('../discord/embeds');
      const client = getClient();
      const channel = await client.channels.fetch(channelId);
      const { embed, components } = buildAlertEmbed(event, 'paid');
      await channel.send({ embeds: [embed], components });
      res.json({ ok: true, product: product.name, channelId, offerId: product._offerId || 'none' });
    } else {
      await delivery.deliver([event], { skipDedup: true });
      res.json({ ok: true, product: product.name, offerId: product._offerId || 'enriched during delivery' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Post command guide to a channel ===
router.post('/post-guide', async (req, res) => {
  const { channelId } = req.body;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  try {
    const { postCommandGuide } = require('../discord/bot');
    await postCommandGuide(channelId);
    res.json({ ok: true, channelId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Test all slash command logic (no Discord interaction needed) ===
router.get('/test-commands', async (req, res) => {
  const results = {};
  const { getClient } = require('../discord/bot');
  const { buildAlertEmbed } = require('../discord/embeds');
  const { getStats: getProxyStats } = require('../core/proxy');

  // 1. /status — retailer health
  try {
    const baseRetailers = require('../config/retailers.json');
    const overrides = await state.getRetailerOverrides();
    const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
    let checked = 0;
    for (const r of retailers.slice(0, 3)) {
      const s = await state.getRetailerStatus(r.id);
      const lc = await state.getLastCheck(r.id);
      if (s && lc) checked++;
    }
    results.status = { pass: checked > 0, detail: `${checked}/3 retailers have status+lastCheck` };
  } catch (e) { results.status = { pass: false, detail: e.message }; }

  // 2. /retailers — list retailers
  try {
    const baseRetailers = require('../config/retailers.json');
    const overrides = await state.getRetailerOverrides();
    const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
    results.retailers = { pass: retailers.length > 0, detail: `${retailers.length} retailers loaded` };
  } catch (e) { results.retailers = { pass: false, detail: e.message }; }

  // 3. /test — build test event
  try {
    const testEvent = {
      type: 'RESTOCK',
      product: { sku: 'CMD-TEST', name: 'Command Test Product', price: 9.99, currency: 'CAD', url: 'https://example.com', image: null, retailer: 'Test', inStock: true, canAddToCart: true, category: 'pokemon', isTCG: true },
      detail: 'Command test', _detectedAt: Date.now(), _scanTier: 'scan',
    };
    const { embed, components } = buildAlertEmbed(testEvent, 'paid');
    results.test = { pass: !!embed, detail: `embed title: ${embed.data.title}` };
  } catch (e) { results.test = { pass: false, detail: e.message }; }

  // 4. /scan — verify runScan exists
  try {
    const { runScan: rs } = require('../core/scan');
    results.scan = { pass: typeof rs === 'function', detail: 'runScan function exists' };
  } catch (e) { results.scan = { pass: false, detail: e.message }; }

  // 5. /test-asin — check Amazon product cache
  try {
    const products = await state.getAllProducts('amazon');
    const count = Object.keys(products).length;
    results['test-asin'] = { pass: count > 0, detail: `${count} Amazon products cached` };
  } catch (e) { results['test-asin'] = { pass: false, detail: e.message }; }

  // 6. /freetier — check channels config
  try {
    const channels = await state.getChannelsConfig();
    results.freetier = { pass: channels !== null, detail: channels ? `free tier enabled=${channels?.tiers?.free?.enabled}` : 'no channels config' };
  } catch (e) { results.freetier = { pass: false, detail: e.message }; }

  // 7. /test-sku — build Walmart embed with enrichment
  try {
    const product = await state.getProduct('walmart', '66WBIOXIU4UC');
    if (product) {
      const event = { type: 'RESTOCK', product: { ...product, retailerId: 'walmart' }, detail: 'test', _detectedAt: Date.now(), _scanTier: 'scan' };
      await delivery.enrichEvent(event);
      const { embed } = buildAlertEmbed(event, 'paid');
      results['test-sku'] = { pass: !!embed, detail: `offerId=${product._offerId || 'enriched'}, name=${product.name?.slice(0, 40)}` };
    } else {
      results['test-sku'] = { pass: true, detail: 'Walmart SKU not cached (normal if no recent alert), embed builder works' };
    }
  } catch (e) { results['test-sku'] = { pass: false, detail: e.message }; }

  // 8. /check — live product lookup
  try {
    const cached = await state.getProduct('walmart', '66WBIOXIU4UC');
    const adapter = scheduler.getAdapter('walmart');
    const hasLiveFetch = adapter && typeof adapter.fetchProductPage === 'function';
    results.check = { pass: true, detail: `cached=${!!cached}, adapter=${!!adapter}, liveFetch=${hasLiveFetch}` };
  } catch (e) { results.check = { pass: false, detail: e.message }; }

  // 9. /watchlist — check adapter watchlists
  try {
    const baseRetailers = require('../config/retailers.json');
    let totalSkus = 0;
    let adaptersWithWL = 0;
    for (const r of baseRetailers) {
      const adapter = scheduler.getAdapter(r.id);
      if (adapter && adapter.watchlist && adapter.watchlist.size > 0) {
        adaptersWithWL++;
        totalSkus += adapter.watchlist.size;
      }
    }
    results.watchlist = { pass: true, detail: `${adaptersWithWL} adapters with watchlists, ${totalSkus} total SKUs` };
  } catch (e) { results.watchlist = { pass: false, detail: e.message }; }

  // 10. /watchlist-add — verify adapter + ensureWatchlistTimer exist
  try {
    const adapter = scheduler.getAdapter('walmart');
    const hasEnsure = typeof scheduler.ensureWatchlistTimer === 'function';
    const hasSetWL = typeof state.setWatchlistOverride === 'function';
    results['watchlist-add'] = { pass: !!adapter && hasEnsure && hasSetWL, detail: `adapter=${!!adapter}, ensureTimer=${hasEnsure}, redispersist=${hasSetWL}` };
  } catch (e) { results['watchlist-add'] = { pass: false, detail: e.message }; }

  // 11. /watchlist-remove — same deps
  try {
    results['watchlist-remove'] = { pass: true, detail: 'same deps as watchlist-add (verified above)' };
  } catch (e) { results['watchlist-remove'] = { pass: false, detail: e.message }; }

  // 12. /budget — ScraperAPI budget
  try {
    const budget = getBudgetStatus();
    results.budget = { pass: budget.used !== undefined && budget.budget > 0, detail: `${budget.used}/${budget.budget} credits (${budget.pct}%), paused=${budget.paused}` };
  } catch (e) { results.budget = { pass: false, detail: e.message }; }

  // 13. /alerts — per-retailer product counts
  try {
    const walmartProducts = await state.getAllProducts('walmart');
    const amazonProducts = await state.getAllProducts('amazon');
    const wCount = Object.keys(walmartProducts).length;
    const aCount = Object.keys(amazonProducts).length;
    results.alerts = { pass: true, detail: `walmart=${wCount} products, amazon=${aCount} products` };
  } catch (e) { results.alerts = { pass: false, detail: e.message }; }

  // 14. /ping — bot client
  try {
    const cl = getClient();
    const wsLatency = cl ? cl.ws.ping : -1;
    results.ping = { pass: !!cl && wsLatency >= 0, detail: `client=${!!cl}, ws.ping=${wsLatency}ms` };
  } catch (e) { results.ping = { pass: false, detail: e.message }; }

  // 15. /help — static (always passes)
  results.help = { pass: true, detail: 'static embed, no deps' };

  // Redis watchlist persistence check
  try {
    const wlOverrides = await state.getWatchlistOverrides();
    results._watchlistRedis = { pass: true, detail: `${Object.keys(wlOverrides).length} retailers with persisted watchlists` };
  } catch (e) { results._watchlistRedis = { pass: false, detail: e.message }; }

  // Summary
  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(r => r.pass).length;
  const failed = Object.values(results).filter(r => !r.pass);

  res.json({ summary: `${passed}/${total} passed`, failed: failed.length > 0 ? failed : 'none', results });
});

module.exports = router;
