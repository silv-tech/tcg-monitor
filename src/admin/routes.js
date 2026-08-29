const express = require('express');
const fs = require('fs');
const path = require('path');
const state = require('../core/state');
const { checkHealth } = require('../monitoring/health');
const { getStats: getProxyStats } = require('../core/proxy');
const scheduler = require('../core/scheduler');
const logger = require('../monitoring/logger');

const delivery = require('../discord/delivery');

const router = express.Router();

const retailersPath = path.join(__dirname, '../config/retailers.json');
const productsPath = path.join(__dirname, '../config/products.json');
const channelsPath = path.join(__dirname, '../config/channels.json');

// Health check
router.get('/health', async (req, res) => {
  const health = await checkHealth();
  const allHealthy = health.every(r => r.healthy);
  res.status(allHealthy ? 200 : 503).json({ status: allHealthy ? 'ok' : 'degraded', retailers: health });
});

// List retailers
router.get('/retailers', (req, res) => {
  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  res.json(retailers);
});

// Toggle retailer
router.patch('/retailers/:id', (req, res) => {
  const retailers = JSON.parse(fs.readFileSync(retailersPath, 'utf-8'));
  const idx = retailers.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Retailer not found' });

  if (req.body.enabled !== undefined) retailers[idx].enabled = req.body.enabled;
  if (req.body.intervalMs !== undefined) retailers[idx].intervalMs = req.body.intervalMs;

  fs.writeFileSync(retailersPath, JSON.stringify(retailers, null, 2));
  res.json(retailers[idx]);
});

// List tracked products/keywords
router.get('/products', (req, res) => {
  const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
  res.json(products);
});

// Add tracked SKU
router.post('/products/tracked', (req, res) => {
  const { sku, retailer, name } = req.body;
  if (!sku || !retailer) return res.status(400).json({ error: 'sku and retailer required' });

  const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
  const exists = products.tracked.some(t => t.sku === sku && t.retailer === retailer);
  if (exists) return res.status(409).json({ error: 'Already tracked' });

  products.tracked.push({ sku, retailer, name: name || sku, addedAt: new Date().toISOString() });
  fs.writeFileSync(productsPath, JSON.stringify(products, null, 2));
  res.status(201).json({ ok: true });
});

// Remove tracked SKU
router.delete('/products/tracked/:retailer/:sku', (req, res) => {
  const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
  const before = products.tracked.length;
  products.tracked = products.tracked.filter(
    t => !(t.sku === req.params.sku && t.retailer === req.params.retailer)
  );
  if (products.tracked.length === before) return res.status(404).json({ error: 'Not found' });
  fs.writeFileSync(productsPath, JSON.stringify(products, null, 2));
  res.json({ ok: true });
});

// Add keyword
router.post('/products/keywords', (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });

  const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
  if (products.keywords.includes(keyword)) return res.status(409).json({ error: 'Already exists' });

  products.keywords.push(keyword);
  fs.writeFileSync(productsPath, JSON.stringify(products, null, 2));
  res.json({ ok: true });
});

// Remove keyword
router.delete('/products/keywords/:keyword', (req, res) => {
  const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));
  const idx = products.keywords.indexOf(req.params.keyword);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  products.keywords.splice(idx, 1);
  fs.writeFileSync(productsPath, JSON.stringify(products, null, 2));
  res.json({ ok: true });
});

// Proxy stats
router.get('/stats/proxy', (req, res) => {
  res.json(getProxyStats());
});

// Retailer state (cached products)
router.get('/state/:retailerId', async (req, res) => {
  const products = await state.getAllProducts(req.params.retailerId);
  res.json({ retailerId: req.params.retailerId, productCount: Object.keys(products).length, products });
});

// Get channel config
router.get('/channels', (req, res) => {
  const channels = JSON.parse(fs.readFileSync(channelsPath, 'utf-8'));
  res.json(channels);
});

// Update channel config
router.put('/channels', (req, res) => {
  fs.writeFileSync(channelsPath, JSON.stringify(req.body, null, 2));
  delivery.reloadChannels();
  res.json({ ok: true });
});

// Update a single channel or role mapping
router.patch('/channels', (req, res) => {
  const channels = JSON.parse(fs.readFileSync(channelsPath, 'utf-8'));
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
  fs.writeFileSync(channelsPath, JSON.stringify(channels, null, 2));
  delivery.reloadChannels();
  res.json(channels);
});

module.exports = router;
