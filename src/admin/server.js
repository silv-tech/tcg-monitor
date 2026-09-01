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
}, 300000).unref();

// ─── Timing-safe comparison helper (P0-3) ────────────────────────
function timingSafeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Session tokens (in-memory) ──────────────────────────────────
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

// Clean expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 30 * 60 * 1000).unref();

function createAdminServer() {
  const app = express();

  // P2-6: No open CORS — dashboard is served from same origin, no cross-origin needed
  app.use(express.json({ limit: '100kb' }));

  // ─── Login rate limit (#19): 5 attempts per minute per IP ────────
  const loginAttempts = new Map();
  const LOGIN_LIMIT = 5;
  const LOGIN_WINDOW_MS = 60000;

  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    let window = loginAttempts.get(ip);
    if (!window || now - window.start > LOGIN_WINDOW_MS) {
      window = { start: now, count: 0 };
      loginAttempts.set(ip, window);
    }
    window.count++;
    if (window.count > LOGIN_LIMIT) {
      return res.status(429).json({ error: 'Too many login attempts — try again in a minute' });
    }

    const { username, password } = req.body || {};
    const validUser = timingSafeCompare(username, config.admin.username);
    const validPass = timingSafeCompare(password, config.admin.password);

    if (validUser && validPass) {
      const token = createSession();
      return res.json({ token });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  });

  // Auth middleware — accepts session token OR legacy API key
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/login') return next();

    // Check session token first (dashboard)
    const authHeader = req.headers['authorization'] || '';
    const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (isValidSession(sessionToken)) return next();

    // Fallback to API key (health-check script, programmatic access)
    const apiKey = req.headers['x-api-key'] || req.query.key;
    if (timingSafeCompare(apiKey, config.admin.apiKey)) return next();

    return res.status(401).json({ error: 'Unauthorized' });
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
