const BASE = window.location.origin + '/api';
let apiKey = '';

function headers() {
  return { 'Content-Type': 'application/json', 'x-api-key': apiKey };
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers(), ...opts.headers } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
  el.scrollTop = el.scrollHeight;
}

// Tab switching
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab-content#tab-${name}`).classList.add('active');
  event.target.classList.add('active');

  if (name === 'performance') loadPerformance();
  if (name === 'channels') loadChannels();
}

async function loadAll() {
  apiKey = document.getElementById('apiKey').value;
  try {
    await Promise.all([loadHealth(), loadRetailers(), loadProducts(), loadStats()]);
    log('Connected successfully');
  } catch (err) {
    log('Error: ' + err.message);
    document.getElementById('sysStatus').textContent = 'Error';
    document.getElementById('sysStatus').className = 'status bad';
  }
}

async function loadHealth() {
  try {
    const data = await api('/health');
    const el = document.getElementById('sysStatus');
    const healthy = data.retailers.filter(r => r.healthy).length;
    const total = data.retailers.length;

    if (data.status === 'ok') {
      el.textContent = 'Healthy';
      el.className = 'status ok';
    } else {
      el.textContent = 'Degraded';
      el.className = 'status warn';
    }
    document.getElementById('statRetailers').textContent = total;
    document.getElementById('statRetailersSub').textContent = `${healthy} healthy`;
  } catch {
    document.getElementById('sysStatus').textContent = 'Down';
    document.getElementById('sysStatus').className = 'status bad';
  }
}

async function loadRetailers() {
  const retailers = await api('/retailers');
  const enabled = retailers.filter(r => r.enabled).length;
  document.getElementById('retailerCount').textContent = `${enabled} active / ${retailers.length} total`;

  const grid = document.getElementById('retailersGrid');
  grid.innerHTML = retailers.map(r => {
    const dotClass = r.enabled ? 'green' : 'yellow';
    const adapter = r.adapter || '—';
    const proxy = r.proxyTier === 'none' ? 'Direct' : r.proxyTier;
    const interval = (r.intervalMs / 1000).toFixed(0);
    const note = r._note ? `<div style="font-size:11px;color:#666;margin-top:4px;font-style:italic">${r._note}</div>` : '';
    return `
      <div class="card">
        <div class="name">
          <span class="health-dot ${dotClass}"></span>
          <span style="border-left:3px solid ${r.color || '#555'};padding-left:8px">${r.name}</span>
        </div>
        <div class="meta">
          Adapter: <span class="val">${adapter}</span> &bull;
          Interval: <span class="val">${interval}s</span> &bull;
          Proxy: <span class="val">${proxy}</span>
          ${note}
          <br>
          <button class="toggle" onclick="toggleRetailer('${r.id}', ${!r.enabled})">
            ${r.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleRetailer(id, enabled) {
  await api(`/retailers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  log(`${id} ${enabled ? 'enabled' : 'disabled'}`);
  await loadRetailers();
}

async function loadProducts() {
  const data = await api('/products');
  document.getElementById('statProducts').textContent = data.tracked.length;

  const kwEl = document.getElementById('keywordsList');
  kwEl.innerHTML = data.keywords.map(kw => `
    <span style="display:inline-block;background:#333;padding:3px 10px;border-radius:12px;margin:3px;font-size:13px;">
      ${kw} <span style="cursor:pointer;color:#f87171;margin-left:4px;" onclick="removeKeyword('${kw}')">&times;</span>
    </span>
  `).join('');

  const tbody = document.getElementById('skuTable');
  tbody.innerHTML = data.tracked.map(t => `
    <tr>
      <td>${t.sku}</td>
      <td>${t.retailer}</td>
      <td>${t.name}</td>
      <td>${t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '—'}</td>
      <td><button class="btn-danger" onclick="removeSku('${t.retailer}','${t.sku}')">Remove</button></td>
    </tr>
  `).join('');
}

async function loadStats() {
  const stats = await api('/stats/proxy');

  document.getElementById('statUptime').textContent = `${stats.uptimeHours}h`;
  document.getElementById('statRequests').textContent = formatNum(stats.requests);
  document.getElementById('statReqRate').textContent = `${stats.requestsPerMinute}/min`;
  document.getElementById('statBlocked').textContent = formatNum(stats.blocked);

  const blockRate = stats.requests > 0 ? ((stats.blocked / stats.requests) * 100).toFixed(1) : '0';
  document.getElementById('statBlockRate').textContent = `${blockRate}% rate`;

  document.getElementById('statAvgPoll').textContent = stats.latency.avgPollMs || '—';
  document.getElementById('statAvgAlert').textContent = stats.latency.avgAlertMs || '—';
  document.getElementById('statCost').textContent = `$${stats.cost.totalEstimatedUsd.toFixed(2)}`;
}

async function loadPerformance() {
  const stats = await api('/stats/proxy');

  // Per-retailer table
  const perfBody = document.getElementById('perfTable');
  const retailers = Object.entries(stats.byRetailer || {});
  perfBody.innerHTML = retailers.map(([id, r]) => {
    const blockRate = r.requests > 0 ? ((r.blocked / r.requests) * 100).toFixed(1) : '0';
    const avgLatency = r.polls > 0 ? Math.round(r.totalLatencyMs / r.polls) : '—';
    const latencyClass = avgLatency === '—' ? '' : avgLatency < 2000 ? 'fast' : avgLatency < 5000 ? 'medium' : 'slow';
    const statusClass = r.blocked === 0 ? 'ok' : blockRate > 50 ? 'bad' : 'warn';
    const statusText = r.blocked === 0 ? 'OK' : blockRate > 50 ? 'Degraded' : 'Partial';
    return `
      <tr>
        <td>${id}</td>
        <td>${r.requests}</td>
        <td>${r.blocked}</td>
        <td>${blockRate}%</td>
        <td>
          ${avgLatency}ms
          ${avgLatency !== '—' ? `<div class="latency-bar"><div class="fill ${latencyClass}" style="width:${Math.min(avgLatency / 100, 100)}%"></div></div>` : ''}
        </td>
        <td><span class="status ${statusClass}">${statusText}</span></td>
      </tr>
    `;
  }).join('');

  if (retailers.length === 0) {
    perfBody.innerHTML = '<tr><td colspan="6" style="color:#666;text-align:center">No data yet — polls haven\'t run</td></tr>';
  }

  // Cost breakdown table
  const costBody = document.getElementById('costTable');
  const tiers = stats.cost.byTier || {};
  costBody.innerHTML = Object.entries(tiers).map(([tier, cost]) => `
    <tr>
      <td style="text-transform:capitalize">${tier}</td>
      <td>${tier === 'none' ? 'N/A' : '—'}</td>
      <td>$${cost.toFixed(4)}</td>
    </tr>
  `).join('');
}

async function loadChannels() {
  try {
    const channels = await api('/channels');
    document.getElementById('channelsJson').textContent = JSON.stringify(channels, null, 2);
  } catch {
    document.getElementById('channelsJson').textContent = 'Failed to load channel config';
  }
}

async function addKeyword() {
  const keyword = document.getElementById('newKeyword').value.trim();
  if (!keyword) return;
  await api('/products/keywords', { method: 'POST', body: JSON.stringify({ keyword }) });
  document.getElementById('newKeyword').value = '';
  log(`Added keyword: ${keyword}`);
  await loadProducts();
}

async function removeKeyword(kw) {
  await api(`/products/keywords/${encodeURIComponent(kw)}`, { method: 'DELETE' });
  log(`Removed keyword: ${kw}`);
  await loadProducts();
}

async function addSku() {
  const sku = document.getElementById('newSku').value.trim();
  const retailer = document.getElementById('newSkuRetailer').value.trim();
  const name = document.getElementById('newSkuName').value.trim();
  if (!sku || !retailer) return;
  await api('/products/tracked', { method: 'POST', body: JSON.stringify({ sku, retailer, name }) });
  document.getElementById('newSku').value = '';
  document.getElementById('newSkuRetailer').value = '';
  document.getElementById('newSkuName').value = '';
  log(`Added SKU: ${retailer}/${sku}`);
  await loadProducts();
}

async function removeSku(retailer, sku) {
  await api(`/products/tracked/${retailer}/${sku}`, { method: 'DELETE' });
  log(`Removed SKU: ${retailer}/${sku}`);
  await loadProducts();
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// Auto-refresh every 30s
setInterval(() => {
  if (apiKey) {
    loadHealth();
    loadStats();
  }
}, 30000);
