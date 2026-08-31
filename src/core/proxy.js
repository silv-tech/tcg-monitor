const config = require('../config');
const logger = require('../monitoring/logger');

let proxiesConfig;
// Load proxy config: env var (for production) > file (for local dev)
if (process.env.ISP_PROXY_CONFIG) {
  try {
    proxiesConfig = JSON.parse(process.env.ISP_PROXY_CONFIG);
    logger.info('Proxy config loaded from ISP_PROXY_CONFIG env var');
  } catch (e) {
    logger.warn(`Failed to parse ISP_PROXY_CONFIG: ${e.message}`);
    proxiesConfig = { isp: { proxies: [] } };
  }
} else {
  try {
    proxiesConfig = require('../config/proxies.json');
  } catch {
    proxiesConfig = { isp: { proxies: [] } };
  }
}

// Cost per request estimates (configurable via env)
const COST_PER_GB = {
  residential: parseFloat(process.env.PROXY_COST_PER_GB_RESIDENTIAL) || 12.00,
  datacenter: parseFloat(process.env.PROXY_COST_PER_GB_DATACENTER) || 1.50,
  isp: parseFloat(process.env.PROXY_COST_PER_GB_ISP) || 5.00,
};
const AVG_RESPONSE_KB = 300; // Average response size estimate

// ─── ISP Proxy Pool ──────────────────────────────────────────────
const ispPool = {
  proxies: [],            // Array of { url, healthy, blockedUntil, requests, blocked, assignedTo }
  retailerIndex: new Map(), // retailerId → round-robin pointer within that retailer's pool
  sticky: new Map(),      // retailerId → proxy index (sticky sessions per retailer)
  retailerPools: {},      // retailerId → [proxy indices]
};

function loadIspProxies() {
  const list = proxiesConfig?.isp?.proxies || [];
  ispPool.proxies = list.map((url, i) => ({
    url: normalizeProxyUrl(url),
    index: i,
    healthy: true,
    blockedUntil: 0,
    requests: 0,
    blocked: 0,
    assignedTo: null,
  }));

  // Load per-retailer pool assignments
  ispPool.retailerPools = proxiesConfig?.isp?.retailerPools || {};
  for (const [retailerId, indices] of Object.entries(ispPool.retailerPools)) {
    ispPool.retailerIndex.set(retailerId, 0);
    for (const idx of indices) {
      if (ispPool.proxies[idx]) {
        ispPool.proxies[idx].assignedTo = retailerId;
      }
    }
  }

  if (ispPool.proxies.length > 0) {
    const poolInfo = Object.entries(ispPool.retailerPools)
      .map(([r, idxs]) => `${r}:[${idxs.join(',')}]`)
      .join(', ');
    logger.info(`ISP proxy pool loaded: ${ispPool.proxies.length} proxies | ${poolInfo || 'shared pool'}`);
  }
}

function normalizeProxyUrl(raw) {
  // Accept formats: http://user:pass@ip:port, ip:port:user:pass, ip:port
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('socks')) {
    return raw;
  }
  const parts = raw.split(':');
  if (parts.length === 4) {
    // ip:port:user:pass
    return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  }
  if (parts.length === 2) {
    // ip:port (no auth)
    return `http://${parts[0]}:${parts[1]}`;
  }
  return raw; // Return as-is, let it fail at connection time if invalid
}

function getNextIspProxy(retailerId) {
  if (ispPool.proxies.length === 0) return null;
  const now = Date.now();

  // Determine which proxies this retailer can use
  const allowedIndices = ispPool.retailerPools[retailerId];
  const pool = allowedIndices
    ? allowedIndices.map(i => ispPool.proxies[i]).filter(Boolean)
    : ispPool.proxies; // No assignment = shared pool (fallback)

  if (pool.length === 0) return null;

  // Sticky session: same retailer sticks to same proxy until it breaks
  if (retailerId && ispPool.sticky.has(retailerId)) {
    const stickyIdx = ispPool.sticky.get(retailerId);
    const proxy = ispPool.proxies[stickyIdx];
    if (proxy && proxy.healthy && proxy.blockedUntil < now) {
      return proxy;
    }
    ispPool.sticky.delete(retailerId);
  }

  // Round-robin within this retailer's dedicated pool
  const rrKey = retailerId || '__shared__';
  let rr = ispPool.retailerIndex.get(rrKey) || 0;

  for (let i = 0; i < pool.length; i++) {
    const proxy = pool[(rr + i) % pool.length];

    // Auto-recover cooled-down proxies
    if (!proxy.healthy && proxy.blockedUntil <= now) {
      proxy.healthy = true;
    }

    if (proxy.blockedUntil > now) continue;

    if (proxy.healthy) {
      ispPool.retailerIndex.set(rrKey, (rr + i + 1) % pool.length);
      if (retailerId) ispPool.sticky.set(retailerId, proxy.index);
      return proxy;
    }
  }

  // All proxies in this retailer's pool are in cooldown — force the least-recently-blocked
  logger.warn(`All ISP proxies for ${retailerId || 'shared'} in cooldown, forcing least-blocked`);
  const sorted = [...pool].sort((a, b) => a.blockedUntil - b.blockedUntil);
  sorted[0].healthy = true;
  sorted[0].blockedUntil = 0;
  if (retailerId) ispPool.sticky.set(retailerId, sorted[0].index);
  return sorted[0];
}

function markProxyBlocked(proxy) {
  if (!proxy) return;
  const cooldownMs = proxiesConfig?.isp?.cooldownMs || 1800000;
  proxy.blocked++;
  proxy.blockedUntil = Date.now() + cooldownMs;
  proxy.healthy = false;

  // Remove sticky assignments pointing to this proxy
  for (const [retailerId, idx] of ispPool.sticky.entries()) {
    if (idx === proxy.index) ispPool.sticky.delete(retailerId);
  }

  const assigned = proxy.assignedTo || 'shared';
  logger.warn(`ISP proxy #${proxy.index} (${assigned}) blocked, cooldown ${cooldownMs / 60000}min (total blocks: ${proxy.blocked})`);
}

function markProxySuccess(proxy) {
  if (!proxy) return;
  proxy.requests++;
  proxy.healthy = true;
}

function reloadProxies() {
  delete require.cache[require.resolve('../config/proxies.json')];
  proxiesConfig = require('../config/proxies.json');
  loadIspProxies();
  logger.info('Reloaded proxy config');
}

function getProxyPoolStats() {
  return ispPool.proxies.map(p => ({
    index: p.index,
    url: p.url.replace(/\/\/[^@]+@/, '//***:***@'), // mask credentials
    healthy: p.healthy,
    requests: p.requests,
    blocked: p.blocked,
    cooldownRemaining: Math.max(0, p.blockedUntil - Date.now()),
    assignedTo: p.assignedTo || null,
  }));
}

// ─── Proxy health check ─────────────────────────────────────────
async function testProxy(proxyUrl, label = 'proxy') {
  if (!proxyUrl) return { ok: false, error: 'No proxy URL configured' };
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const agent = new HttpsProxyAgent(proxyUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://httpbin.org/ip', { agent, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const masked = proxyUrl.replace(/\/\/[^@]+@/, '//***:***@');
    logger.info(`${label} health check PASSED — exit IP: ${data.origin}, proxy: ${masked}`);
    return { ok: true, ip: data.origin };
  } catch (err) {
    logger.error(`${label} health check FAILED: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── Original proxy selection (residential/datacenter) ───────────
function getProxyUrl(proxyTier, retailerId) {
  switch (proxyTier) {
    case 'isp': {
      const proxy = getNextIspProxy(retailerId);
      return proxy ? proxy.url : null;
    }
    case 'residential':
      return config.proxy.residentialUrl || null;
    case 'datacenter':
      return config.proxy.datacenterUrl || null;
    default:
      return null;
  }
}

// ─── Stats ───────────────────────────────────────────────────────
const stats = {
  requests: 0,
  blocked: 0,
  startedAt: Date.now(),
  byRetailer: {},
  latency: {
    polls: [],
    alerts: [],
    avgPollMs: 0,
    avgAlertMs: 0,
    maxPollMs: 0,
    maxAlertMs: 0,
  },
  cost: {
    totalEstimatedUsd: 0,
    byTier: { residential: 0, datacenter: 0, isp: 0, none: 0 },
  },
};

const MAX_LATENCY_SAMPLES = 100;

function recordRequest(retailerId, blocked = false, proxyTier = 'none') {
  stats.requests++;
  if (blocked) stats.blocked++;
  if (!stats.byRetailer[retailerId]) {
    stats.byRetailer[retailerId] = { requests: 0, blocked: 0, totalLatencyMs: 0, polls: 0 };
  }
  stats.byRetailer[retailerId].requests++;
  if (blocked) stats.byRetailer[retailerId].blocked++;

  // Estimate proxy cost
  if (proxyTier !== 'none' && COST_PER_GB[proxyTier]) {
    const costPerReq = (AVG_RESPONSE_KB / 1024 / 1024) * COST_PER_GB[proxyTier];
    stats.cost.totalEstimatedUsd += costPerReq;
    stats.cost.byTier[proxyTier] = (stats.cost.byTier[proxyTier] || 0) + costPerReq;
  }
}

function recordPollLatency(retailerId, ms) {
  stats.latency.polls.push(ms);
  if (stats.latency.polls.length > MAX_LATENCY_SAMPLES) stats.latency.polls.shift();
  stats.latency.avgPollMs = Math.round(stats.latency.polls.reduce((a, b) => a + b, 0) / stats.latency.polls.length);
  if (ms > stats.latency.maxPollMs) stats.latency.maxPollMs = ms;

  if (stats.byRetailer[retailerId]) {
    stats.byRetailer[retailerId].totalLatencyMs += ms;
    stats.byRetailer[retailerId].polls++;
  }
}

function recordAlertLatency(ms) {
  stats.latency.alerts.push(ms);
  if (stats.latency.alerts.length > MAX_LATENCY_SAMPLES) stats.latency.alerts.shift();
  stats.latency.avgAlertMs = Math.round(stats.latency.alerts.reduce((a, b) => a + b, 0) / stats.latency.alerts.length);
  if (ms > stats.latency.maxAlertMs) stats.latency.maxAlertMs = ms;
}

function getStats() {
  const uptimeMs = Date.now() - stats.startedAt;
  return {
    ...stats,
    uptimeHours: (uptimeMs / 3600000).toFixed(1),
    requestsPerMinute: stats.requests > 0 ? (stats.requests / (uptimeMs / 60000)).toFixed(1) : 0,
    cost: {
      ...stats.cost,
      totalEstimatedUsd: parseFloat(stats.cost.totalEstimatedUsd.toFixed(4)),
    },
    proxyPool: getProxyPoolStats(),
  };
}

function resetStats() {
  stats.requests = 0;
  stats.blocked = 0;
  stats.startedAt = Date.now();
  stats.byRetailer = {};
  stats.latency = { polls: [], alerts: [], avgPollMs: 0, avgAlertMs: 0, maxPollMs: 0, maxAlertMs: 0 };
  stats.cost = { totalEstimatedUsd: 0, byTier: { residential: 0, datacenter: 0, isp: 0, none: 0 } };
}

// Initialize pool on load
loadIspProxies();

module.exports = {
  getProxyUrl,
  getNextIspProxy,
  recordRequest,
  recordPollLatency,
  recordAlertLatency,
  getStats,
  resetStats,
  markProxyBlocked,
  markProxySuccess,
  reloadProxies,
  getProxyPoolStats,
  testProxy,
};
