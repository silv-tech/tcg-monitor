const express = require('express');
const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const routes = require('./routes');
const logger = require('../monitoring/logger');

// ─── Simple in-memory rate limiter for write endpoints (P0-6) ────
const rateWindows = new Map();
const RATE_LIMIT = 30;       // max write requests per window
const RATE_WINDOW_MS = 60000; // 1 minute

function rateLimit(req, res, next) {
  if (req.method === 'GET') return next();

  const ip = req.ip;
  const now = Date.now();
  let window = rateWindows.get(ip);

  if (!window || now - window.start > RATE_WINDOW_MS) {
    window = { start: now, count: 0 };
    rateWindows.set(ip, window);
  }

  window.count++;
  if (window.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Too many requests — try again in a minute' });
  }
  next();
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, w] of rateWindows) {
    if (w.start < cutoff) rateWindows.delete(ip);
  }
}, 300000);

// ─── Timing-safe API key comparison (P0-3) ───────────────────────
function isValidApiKey(provided) {
  if (!provided) return false;
  const expected = config.admin.apiKey;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createAdminServer() {
  const app = express();

  // P2-6: No open CORS — dashboard is served from same origin, no cross-origin needed
  app.use(express.json({ limit: '100kb' }));

  // API key auth for admin routes
  app.use('/api', (req, res, next) => {
    // Health endpoint is public (used by uptime monitors)
    if (req.path === '/health') return next();

    const key = req.headers['x-api-key'] || req.query.key;
    if (!isValidApiKey(key)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // Rate limit write operations
  app.use('/api', rateLimit);

  app.use('/api', routes);

  // Serve admin UI
  app.use(express.static(path.join(__dirname, '../../admin-ui')));
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../admin-ui/index.html'));
  });

  const server = app.listen(config.admin.port, () => {
    logger.info(`Admin server running on port ${config.admin.port}`);
  });

  return server;
}

module.exports = { createAdminServer };
