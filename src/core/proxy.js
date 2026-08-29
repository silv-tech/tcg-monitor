const config = require('../config');
const logger = require('../monitoring/logger');

const stats = {
  requests: 0,
  blocked: 0,
  byRetailer: {},
};

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

function recordRequest(retailerId, blocked = false) {
  stats.requests++;
  if (blocked) stats.blocked++;
  if (!stats.byRetailer[retailerId]) {
    stats.byRetailer[retailerId] = { requests: 0, blocked: 0 };
  }
  stats.byRetailer[retailerId].requests++;
  if (blocked) stats.byRetailer[retailerId].blocked++;
}

function getStats() {
  return { ...stats };
}

function resetStats() {
  stats.requests = 0;
  stats.blocked = 0;
  stats.byRetailer = {};
}

module.exports = { getProxyUrl, recordRequest, getStats, resetStats };
