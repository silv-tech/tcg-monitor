const config = require('../config');
const logger = require('../monitoring/logger');

// Cost per request estimates (configurable via env)
const COST_PER_GB = {
  residential: parseFloat(process.env.PROXY_COST_PER_GB_RESIDENTIAL) || 12.00,
  datacenter: parseFloat(process.env.PROXY_COST_PER_GB_DATACENTER) || 1.50,
};
const AVG_RESPONSE_KB = 300; // Average response size estimate

const stats = {
  requests: 0,
  blocked: 0,
  startedAt: Date.now(),
  byRetailer: {},
  latency: {
    polls: [],      // Last 100 poll latencies
    alerts: [],     // Last 100 alert delivery latencies
    avgPollMs: 0,
    avgAlertMs: 0,
    maxPollMs: 0,
    maxAlertMs: 0,
  },
  cost: {
    totalEstimatedUsd: 0,
    byTier: { residential: 0, datacenter: 0, none: 0 },
  },
};

const MAX_LATENCY_SAMPLES = 100;

function getProxyUrl(proxyTier) {
  switch (proxyTier) {
    case 'residential':
      return config.proxy.residentialUrl || null;
    case 'datacenter':
      return config.proxy.datacenterUrl || null;
    default:
      return null;
  }
}

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
  };
}

function resetStats() {
  stats.requests = 0;
  stats.blocked = 0;
  stats.startedAt = Date.now();
  stats.byRetailer = {};
  stats.latency = { polls: [], alerts: [], avgPollMs: 0, avgAlertMs: 0, maxPollMs: 0, maxAlertMs: 0 };
  stats.cost = { totalEstimatedUsd: 0, byTier: { residential: 0, datacenter: 0, none: 0 } };
}

module.exports = { getProxyUrl, recordRequest, recordPollLatency, recordAlertLatency, getStats, resetStats };
