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

  const changes = {};
  if (req.body.enabled !== undefined) changes.enabled = req.body.enabled;
  if (req.body.intervalMs !== undefined) changes.intervalMs = req.body.intervalMs;

  await state.setRetailerOverride(req.params.id, changes);
  res.json({ ...retailer, ...changes });
});

// Add new retailer
router.post('/retailers', (req, res) => {
  const { id, name, url, adapter, intervalMs, proxyTier, color } = req.body;
  if (!id || !name || !url || !adapter) {
    return res.status(400).json({ error: 'id, name, url, and adapter are required' });
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
  if (hours !== 12 && hours !== 24) {
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

// Helper: save channels config to both Redis and file (file needed for delivery.reloadChannels())
async function saveChannelsConfig(channels) {
  await state.setChannelsConfig(channels);
  atomicWriteSync(channelsPath, JSON.stringify(channels, null, 2));
  delivery.reloadChannels();
}

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
  const channels = await getChannelsWithRedis();
  // Deep merge
  function merge(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        merge(target[key], source[key]);
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

// Update proxy list
router.put('/proxies', (req, res) => {
  atomicWriteSync(proxiesPath, JSON.stringify(req.body, null, 2));
  reloadProxies();
  res.json({ ok: true, pool: getProxyPoolStats() });
});

module.exports = router;
