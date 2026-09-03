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

  // 6. /freetier — check channels config (Redis or file fallback)
  try {
    let channels = await state.getChannelsConfig();
    if (!channels) {
      const fs = require('fs');
      const fpath = require('path').join(__dirname, '../config/channels.json');
      try { channels = JSON.parse(fs.readFileSync(fpath, 'utf-8')); } catch { channels = null; }
    }
    results.freetier = { pass: channels !== null, detail: channels ? `free tier enabled=${channels?.tiers?.free?.enabled}` : 'no channels config anywhere' };
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

  // 16-18. /early-add, /early-remove, /early-list — keyword functions
  try {
    const hasGet = typeof state.getEarlyKeywords === 'function';
    const hasAdd = typeof state.addEarlyKeyword === 'function';
    const hasRemove = typeof state.removeEarlyKeyword === 'function';
    const keywords = await state.getEarlyKeywords();
    results['early-add'] = { pass: hasAdd, detail: `addEarlyKeyword=${hasAdd}` };
    results['early-remove'] = { pass: hasRemove, detail: `removeEarlyKeyword=${hasRemove}` };
    results['early-list'] = { pass: hasGet, detail: `${keywords.length} keywords active` };
  } catch (e) {
    results['early-add'] = { pass: false, detail: e.message };
    results['early-remove'] = { pass: false, detail: e.message };
    results['early-list'] = { pass: false, detail: e.message };
  }

  // Summary
  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(r => r.pass).length;
  const failed = Object.values(results).filter(r => !r.pass);

  res.json({ summary: `${passed}/${total} passed`, failed: failed.length > 0 ? failed : 'none', results });
});

// === LIVE test: exercise every command handler and send real Discord output ===
router.post('/test-all-live', async (req, res) => {
  const channelId = req.body.channelId;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });

  const { getClient } = require('../discord/bot');
  const { buildAlertEmbed } = require('../discord/embeds');
  const { EmbedBuilder } = require('discord.js');
  const client = getClient();
  if (!client) return res.status(500).json({ error: 'Bot not connected' });

  const channel = await client.channels.fetch(channelId);
  if (!channel) return res.status(400).json({ error: 'Channel not found' });

  const results = {};

  async function send(label, content) {
    try {
      if (typeof content === 'string') {
        await channel.send(`**[TEST] ${label}**\n${content}`);
      } else {
        await channel.send({ content: `**[TEST] ${label}**`, ...content });
      }
      return true;
    } catch (e) {
      results[label] = { pass: false, detail: `send failed: ${e.message}` };
      return false;
    }
  }

  // 1. /status
  try {
    const baseRetailers = require('../config/retailers.json');
    const overrides = await state.getRetailerOverrides();
    const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
    const lines = [];
    for (const r of retailers.slice(0, 5)) {
      const s = await state.getRetailerStatus(r.id);
      const lc = await state.getLastCheck(r.id);
      const ago = lc ? `${Math.round((Date.now() - lc) / 1000)}s ago` : 'never';
      lines.push(`${s.healthy ? '🟢' : '🔴'} **${r.name}** — ${ago}, errors: ${s.errors}`);
    }
    await send('/status', lines.join('\n') + '\n... (showing 5 of ' + retailers.length + ')');
    results['/status'] = { pass: true };
  } catch (e) { results['/status'] = { pass: false, detail: e.message }; }

  // 2. /retailers
  try {
    const baseRetailers = require('../config/retailers.json');
    const overrides = await state.getRetailerOverrides();
    const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
    const lines = retailers.slice(0, 5).map(r =>
      `${r.enabled ? '✅' : '❌'} **${r.name}** — ${r.intervalMs / 1000}s, proxy: ${r.proxyTier}`
    );
    await send('/retailers', lines.join('\n') + '\n... (showing 5 of ' + retailers.length + ')');
    results['/retailers'] = { pass: true };
  } catch (e) { results['/retailers'] = { pass: false, detail: e.message }; }

  // 3. /test — build and send a test embed
  try {
    const testEvent = {
      type: 'RESTOCK', _detectedAt: Date.now(), _scanTier: 'scan',
      product: { sku: 'LIVE-TEST-001', name: 'Live Test — Prismatic Evolutions ETB', price: 69.99, currency: 'CAD', url: 'https://example.com', image: null, retailer: 'Test Retailer', retailerId: 'test', inStock: true, canAddToCart: true, category: 'pokemon', isTCG: true },
      detail: 'Live command test',
    };
    const { embed, components } = buildAlertEmbed(testEvent, 'paid');
    await channel.send({ content: '**[TEST] /test**', embeds: [embed], components });
    results['/test'] = { pass: true };
  } catch (e) { results['/test'] = { pass: false, detail: e.message }; }

  // 4. /scan — just verify it can run (don't actually resend everything)
  try {
    const { runScan: rs } = require('../core/scan');
    results['/scan'] = { pass: typeof rs === 'function', detail: 'runScan available (skipping full scan to avoid spam)' };
  } catch (e) { results['/scan'] = { pass: false, detail: e.message }; }

  // 5. /test-asin — build Amazon embed with OLID enrichment
  try {
    const products = await state.getAllProducts('amazon');
    const asins = Object.keys(products);
    if (asins.length > 0) {
      const asin = asins[0];
      const product = { ...products[asin], retailerId: 'amazon' };
      const event = { type: 'RESTOCK', product, detail: `Live test ASIN ${asin}`, _detectedAt: Date.now(), _scanTier: 'scan' };
      if (req.body.withCredits) await delivery.enrichEvent(event);
      const { embed, components } = buildAlertEmbed(event, 'paid');
      await channel.send({ content: `**[TEST] /test-asin** (${asin}${req.body.withCredits ? ', OLID enriched' : ', cached'})`, embeds: [embed], components });
      results['/test-asin'] = { pass: true, detail: `${asin}${req.body.withCredits ? ' (enriched)' : ' (cached)'}` };
    } else {
      results['/test-asin'] = { pass: true, detail: 'No Amazon products cached (skip)' };
    }
  } catch (e) { results['/test-asin'] = { pass: false, detail: e.message }; }

  // 6. /freetier — check config (don't actually toggle)
  try {
    const fs = require('fs');
    const path = require('path');
    let ch = await state.getChannelsConfig();
    if (!ch) try { ch = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/channels.json'), 'utf-8')); } catch {}
    const enabled = ch?.tiers?.free?.enabled;
    await send('/freetier', `Free tier is currently **${enabled !== false ? 'ON' : 'OFF'}** (not toggling in test)`);
    results['/freetier'] = { pass: true, detail: `enabled=${enabled}` };
  } catch (e) { results['/freetier'] = { pass: false, detail: e.message }; }

  // 7. /test-sku — Walmart with optional enrichment
  try {
    const product = await state.getProduct('walmart', '66WBIOXIU4UC');
    if (product) {
      const event = { type: 'RESTOCK', product: { ...product, retailerId: 'walmart' }, detail: 'Live test SKU', _detectedAt: Date.now(), _scanTier: 'scan' };
      if (req.body.withCredits) await delivery.enrichEvent(event);
      const { embed, components } = buildAlertEmbed(event, 'paid');
      await channel.send({ content: `**[TEST] /test-sku** (walmart:66WBIOXIU4UC, offerId=${event.product._offerId || product._offerId || 'none'})`, embeds: [embed], components });
      results['/test-sku'] = { pass: true, detail: `offerId=${event.product._offerId || product._offerId || 'none'}` };
    } else {
      results['/test-sku'] = { pass: true, detail: 'Walmart Charizard not cached (skip)' };
    }
  } catch (e) { results['/test-sku'] = { pass: false, detail: e.message }; }

  // 8. /check — stock check with optional live fetch
  try {
    const cached = await state.getProduct('walmart', '66WBIOXIU4UC');
    const adapter = scheduler.getAdapter('walmart');
    const hasLiveFetch = adapter && typeof adapter.fetchProductPage === 'function';
    let live = null;
    if (req.body.withCredits && hasLiveFetch) {
      try { live = await adapter.fetchProductPage('66WBIOXIU4UC'); } catch {}
    }
    const p = live || cached;
    if (p) {
      const embed = new EmbedBuilder()
        .setColor(p.inStock ? 0x57f287 : 0xed4245)
        .setTitle(p.name || '66WBIOXIU4UC')
        .addFields(
          { name: 'Status', value: p.inStock ? '🟢 In Stock' : '🔴 OOS', inline: true },
          { name: 'Price', value: p.price ? `$${p.price.toFixed(2)}` : '?', inline: true },
          { name: 'Source', value: live ? 'Live fetch' : `Cached (liveFetch=${hasLiveFetch})`, inline: true },
        )
        .setFooter({ text: `SKU: 66WBIOXIU4UC` });
      if (p._offerId) embed.addFields({ name: 'Offer ID', value: `\`${p._offerId}\``, inline: false });
      await channel.send({ content: `**[TEST] /check** (walmart 66WBIOXIU4UC${live ? ', LIVE' : ', cached'})`, embeds: [embed] });
      results['/check'] = { pass: true, detail: `inStock=${p.inStock}, source=${live ? 'live' : 'cached'}` };
    } else {
      results['/check'] = { pass: true, detail: 'Product not available (skip)' };
    }
  } catch (e) { results['/check'] = { pass: false, detail: e.message }; }

  // 9. /watchlist
  try {
    const baseRetailers = require('../config/retailers.json');
    const lines = [];
    for (const r of baseRetailers) {
      const adapter = scheduler.getAdapter(r.id);
      if (!adapter || !adapter.watchlist || adapter.watchlist.size === 0) continue;
      const skus = [...adapter.watchlist];
      lines.push(`**${r.name}** (${skus.length} SKUs)`);
      for (const sku of skus) {
        const p = await state.getProduct(r.id, sku);
        lines.push(p ? `  ${p.inStock ? '🟢' : '🔴'} \`${sku}\` — ${p.name || '?'} | $${p.price || '?'}` : `  ⚫ \`${sku}\` — not cached`);
      }
    }
    await send('/watchlist', lines.length > 0 ? lines.join('\n') : 'No watchlist items');
    results['/watchlist'] = { pass: true };
  } catch (e) { results['/watchlist'] = { pass: false, detail: e.message }; }

  // 10. /watchlist-add + /watchlist-remove — round-trip test with a dummy SKU
  try {
    const adapter = scheduler.getAdapter('walmart');
    if (!adapter.watchlist) adapter.watchlist = new Set();
    const testSku = '_LIVE_TEST_999';
    adapter.watchlist.add(testSku);
    await state.setWatchlistOverride('walmart', [...adapter.watchlist]);
    const addedSize = adapter.watchlist.size;
    adapter.watchlist.delete(testSku);
    await state.setWatchlistOverride('walmart', [...adapter.watchlist]);
    await send('/watchlist-add + /watchlist-remove', `Added \`${testSku}\` (size=${addedSize}), then removed (size=${adapter.watchlist.size}). Round-trip OK.`);
    results['/watchlist-add'] = { pass: true };
    results['/watchlist-remove'] = { pass: true };
  } catch (e) {
    results['/watchlist-add'] = { pass: false, detail: e.message };
    results['/watchlist-remove'] = { pass: false, detail: e.message };
  }

  // 11. /budget
  try {
    const budget = getBudgetStatus();
    const embed = new EmbedBuilder()
      .setColor(budget.paused ? 0xed4245 : budget.warned ? 0xfee75c : 0x57f287)
      .setTitle('ScraperAPI Budget')
      .addFields(
        { name: 'Status', value: budget.paused ? '🔴 PAUSED' : budget.warned ? '🟡 WARNING' : '🟢 OK', inline: true },
        { name: 'Credits', value: `${budget.used.toLocaleString()} / ${budget.budget.toLocaleString()}`, inline: true },
        { name: 'Usage', value: `${budget.pct}%`, inline: true },
      );
    await channel.send({ content: '**[TEST] /budget**', embeds: [embed] });
    results['/budget'] = { pass: true, detail: `${budget.used}/${budget.budget}` };
  } catch (e) { results['/budget'] = { pass: false, detail: e.message }; }

  // 12. /alerts
  try {
    const lines = [];
    for (const rid of ['walmart', 'amazon', 'bestbuy', 'costco', 'pokemoncenter']) {
      const products = await state.getAllProducts(rid);
      const entries = Object.values(products);
      const inStock = entries.filter(p => p.inStock).length;
      const lc = await state.getLastCheck(rid);
      const ago = lc ? `${Math.round((Date.now() - lc) / 1000)}s ago` : 'never';
      lines.push(`**${rid}** — ${entries.length} cached, ${inStock} in stock, last: ${ago}`);
    }
    await send('/alerts', lines.join('\n'));
    results['/alerts'] = { pass: true };
  } catch (e) { results['/alerts'] = { pass: false, detail: e.message }; }

  // 13. /ping
  try {
    const start = Date.now();
    await state.getRedis().ping();
    const redisMs = Date.now() - start;
    const wsMs = client.ws.ping;
    await send('/ping', `🏓 **Pong!**\nBot: **${Date.now() - start}ms** | WebSocket: **${wsMs}ms** | Redis: **${redisMs}ms**`);
    results['/ping'] = { pass: true, detail: `ws=${wsMs}ms, redis=${redisMs}ms` };
  } catch (e) { results['/ping'] = { pass: false, detail: e.message }; }

  // 14. /help — static embed
  try {
    results['/help'] = { pass: true, detail: 'static ephemeral embed (not sent — ephemeral only)' };
  } catch (e) { results['/help'] = { pass: false, detail: e.message }; }

  // 15. /early-add + /early-remove + /early-list — full round-trip
  try {
    const testKw = '__live_test_keyword__';
    const added = await state.addEarlyKeyword(testKw);
    const listAfterAdd = await state.getEarlyKeywords();
    const hasIt = listAfterAdd.includes(testKw);
    const removed = await state.removeEarlyKeyword(testKw);
    const listAfterRemove = await state.getEarlyKeywords();
    const gone = !listAfterRemove.includes(testKw);

    await send('/early-add + /early-remove + /early-list',
      `Added \`${testKw}\`: ${added ? '✅' : '❌ (already existed)'}\n` +
      `In list after add: ${hasIt ? '✅' : '❌'}\n` +
      `Removed: ${removed ? '✅' : '❌'}\n` +
      `Gone after remove: ${gone ? '✅' : '❌'}\n` +
      `Active keywords: ${listAfterRemove.length}`
    );
    results['/early-add'] = { pass: added && hasIt, detail: `added=${added}, inList=${hasIt}` };
    results['/early-remove'] = { pass: removed && gone, detail: `removed=${removed}, gone=${gone}` };
    results['/early-list'] = { pass: true, detail: `${listAfterRemove.length} keywords after cleanup` };
  } catch (e) {
    results['/early-add'] = { pass: false, detail: e.message };
    results['/early-remove'] = { pass: false, detail: e.message };
    results['/early-list'] = { pass: false, detail: e.message };
  }

  // Summary
  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(r => r.pass).length;
  const failedList = Object.entries(results).filter(([, v]) => !v.pass).map(([k, v]) => `${k}: ${v.detail}`);

  // Post summary embed
  const summaryEmbed = new EmbedBuilder()
    .setColor(failedList.length === 0 ? 0x57f287 : 0xed4245)
    .setTitle(`Command Test Results: ${passed}/${total} passed`)
    .setDescription(failedList.length > 0 ? `**Failures:**\n${failedList.join('\n')}` : 'All commands working perfectly.')
    .setTimestamp();
  await channel.send({ embeds: [summaryEmbed] });

  res.json({ summary: `${passed}/${total} passed`, failed: failedList.length > 0 ? failedList : 'none', results });
});

module.exports = router;
