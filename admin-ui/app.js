const BASE = window.location.origin + '/api';
let apiKey = '';
let channelsData = null;
let retailersList = [];

// Auto-connect on page load
(async function boot() {
  try {
    const res = await fetch(`${BASE}/bootstrap`);
    const { key } = await res.json();
    apiKey = key;
    await loadAll();
  } catch {
    log('Auto-connect failed — server may be starting up. Retrying in 3s...');
    setTimeout(boot, 3000);
  }
})();

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
  if (name === 'proxies') loadProxies();
}

async function loadAll() {
  try {
    await Promise.all([loadHealth(), loadRetailers(), loadProducts(), loadStats()]);
    log('Connected successfully');
  } catch (err) {
    log('Error: ' + err.message);
    const el = document.getElementById('sysStatus');
    el.innerHTML = '<span class="pulse"></span> Error';
    el.className = 'status-pill bad';
  }
}

async function loadHealth() {
  try {
    const data = await api('/health');
    const el = document.getElementById('sysStatus');
    const healthy = data.retailers.filter(r => r.healthy).length;
    const total = data.retailers.length;

    if (data.status === 'ok') {
      el.innerHTML = '<span class="pulse"></span> Healthy';
      el.className = 'status-pill ok';
    } else {
      el.innerHTML = '<span class="pulse"></span> Degraded';
      el.className = 'status-pill warn';
    }
  } catch {
    const el = document.getElementById('sysStatus');
    el.innerHTML = '<span class="pulse"></span> Down';
    el.className = 'status-pill bad';
  }
}

async function loadRetailers() {
  const [retailers, circuits] = await Promise.all([
    api('/retailers'),
    api('/stats/circuits').catch(() => ({})),
  ]);
  retailersList = retailers;
  const enabled = retailersList.filter(r => r.enabled).length;
  document.getElementById('retailerCount').textContent = `${enabled} active / ${retailersList.length} total`;

  // Update top stat card with accurate retailer count
  document.getElementById('statRetailers').textContent = retailersList.length;
  document.getElementById('statRetailersSub').textContent = `${enabled} active`;

  const grid = document.getElementById('retailersGrid');
  grid.innerHTML = retailersList.map(r => {
    const cb = circuits[r.id];
    const isCircuitOpen = cb && cb.state === 'open';
    const dotClass = !r.enabled ? 'dot-yellow' : isCircuitOpen ? 'dot-red' : 'dot-green';
    const adapter = r.adapter || '—';
    const proxy = r.proxyTier === 'none' ? 'Direct' : r.proxyTier;
    const interval = (r.intervalMs / 1000).toFixed(0);
    const note = r._note ? `<div class="r-note">${r._note}</div>` : '';

    // Circuit breaker status note
    let cbNote = '';
    if (isCircuitOpen) {
      cbNote = `<div class="r-note" style="color:#f87171">Auto-paused (${cb.errors} errors, ${cb.downtimeMin}min). Recovery probe every 5 min.</div>`;
    } else if (cb && cb.errors > 0) {
      cbNote = `<div class="r-note" style="color:#facc15">${cb.errors} consecutive error${cb.errors > 1 ? 's' : ''} — trips at 5</div>`;
    }

    return `
      <div class="r-card">
        <div class="color-bar" style="background:${r.color || '#3f3f46'}"></div>
        <div class="r-header">
          <div class="r-name"><span class="dot ${dotClass}"></span>${r.name}</div>
          <div style="display:flex;gap:6px">
            <button class="toggle-btn" onclick="toggleRetailer('${r.id}', ${!r.enabled})">
              ${r.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="toggle-btn" style="color:#ef4444;border-color:#3f3f46" onclick="removeRetailer('${r.id}','${r.name.replace(/'/g, "\\'")}')">
              Remove
            </button>
          </div>
        </div>
        <div class="r-meta">
          <span>${adapter}</span>
          <span class="r-interval" onclick="editInterval('${r.id}', ${r.intervalMs})" title="Click to edit polling interval" style="cursor:pointer;border-bottom:1px dashed #52525b">${interval}s</span>
          <span>${proxy}</span>
        </div>
        ${note}
        ${cbNote}
      </div>
    `;
  }).join('');
}

async function toggleRetailer(id, enabled) {
  await api(`/retailers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  log(`${id} ${enabled ? 'enabled' : 'disabled'}`);
  await Promise.all([loadRetailers(), loadHealth()]);
}

// ─── Interval Modal ──────────────────────────────────────────────
let _modalRetailerId = null;
let _modalCurrentMs = null;

function editInterval(id, currentMs) {
  const retailer = retailersList.find(r => r.id === id);
  const name = retailer ? retailer.name : id;
  const currentSec = (currentMs / 1000).toFixed(0);

  _modalRetailerId = id;
  _modalCurrentMs = currentMs;

  document.getElementById('modalTitle').textContent = name;
  document.getElementById('modalSub').textContent = `Current interval: ${currentSec}s`;
  const input = document.getElementById('modalIntervalInput');
  input.value = currentSec;

  updateRiskAssessment(parseFloat(currentSec));
  document.getElementById('intervalModal').classList.add('open');

  setTimeout(() => { input.focus(); input.select(); }, 50);

  input.oninput = () => updateRiskAssessment(parseFloat(input.value));
  input.onkeydown = (e) => { if (e.key === 'Enter') confirmInterval(); if (e.key === 'Escape') closeIntervalModal(); };
}

function updateRiskAssessment(sec) {
  const el = document.getElementById('modalRisk');
  if (isNaN(sec) || sec < 1) {
    el.className = 'modal-risk danger';
    el.innerHTML = '<strong>Invalid</strong> — Must be at least 1 second';
    return;
  }
  if (sec < 5) {
    el.className = 'modal-risk danger';
    el.innerHTML = '<strong>DANGER</strong> — High risk of IP bans, may trigger anti-bot permanently, could blacklist proxies';
  } else if (sec < 15) {
    el.className = 'modal-risk warning';
    el.innerHTML = '<strong>WARNING</strong> — Elevated risk of rate limiting, anti-bot systems may flag this pattern';
  } else if (sec < 30) {
    el.className = 'modal-risk caution';
    el.innerHTML = '<strong>CAUTION</strong> — Generally safe with proxy rotation, monitor block rates after changing';
  } else {
    el.className = 'modal-risk safe';
    el.innerHTML = '<strong>SAFE</strong> — This is a safe polling interval';
  }
}

function closeIntervalModal() {
  document.getElementById('intervalModal').classList.remove('open');
  _modalRetailerId = null;
  _modalCurrentMs = null;
}

async function confirmInterval() {
  const input = document.getElementById('modalIntervalInput');
  const newSec = parseFloat(input.value);

  if (isNaN(newSec) || newSec < 1) return;

  const newMs = Math.round(newSec * 1000);
  if (newMs === _modalCurrentMs) { closeIntervalModal(); return; }

  const retailer = retailersList.find(r => r.id === _modalRetailerId);
  const name = retailer ? retailer.name : _modalRetailerId;
  const currentSec = (_modalCurrentMs / 1000).toFixed(0);

  try {
    await api(`/retailers/${_modalRetailerId}`, { method: 'PATCH', body: JSON.stringify({ intervalMs: newMs }) });
    log(`${name}: interval changed ${currentSec}s \u2192 ${newSec}s`);
    closeIntervalModal();
    await loadRetailers();
  } catch (err) {
    log(`Failed to update interval for ${name}: ${err.message}`);
  }
}

async function removeRetailer(id, name) {
  if (!confirm(`Remove "${name}" from the retailer list? This can be re-added later.`)) return;
  try {
    await api(`/retailers/${id}`, { method: 'DELETE' });
    log(`Removed retailer: ${name}`);
    await loadRetailers();
  } catch (err) {
    log(`Failed to remove ${name}: ${err.message}`);
  }
}

async function addRetailer() {
  const id = document.getElementById('newRetailerId').value.trim();
  const name = document.getElementById('newRetailerName').value.trim();
  const url = document.getElementById('newRetailerUrl').value.trim();
  const adapter = document.getElementById('newRetailerAdapter').value;
  const proxyTier = document.getElementById('newRetailerProxy').value;
  if (!id || !name || !url) { log('Retailer ID, name, and URL are required'); return; }

  try {
    await api('/retailers', {
      method: 'POST',
      body: JSON.stringify({ id, name, url, adapter, proxyTier }),
    });
    log(`Added retailer: ${name} (${id})`);
    // Clear form
    document.getElementById('newRetailerId').value = '';
    document.getElementById('newRetailerName').value = '';
    document.getElementById('newRetailerUrl').value = '';
    await loadRetailers();
  } catch (err) {
    log(`Failed to add retailer: ${err.message}`);
  }
}

async function loadProducts() {
  const [data, prodStats] = await Promise.all([
    api('/products'),
    api('/stats/products').catch(() => ({ total: 0, byRetailer: {} })),
  ]);

  // Show actual discovered product count from Redis, not the empty tracked[] array
  document.getElementById('statProducts').textContent = prodStats.total;
  const retailers = Object.entries(prodStats.byRetailer);
  const sub = document.getElementById('statProductsSub');
  if (sub) sub.textContent = retailers.length > 0
    ? `across ${retailers.length} retailer${retailers.length > 1 ? 's' : ''}`
    : 'discovering...';

  const kwEl = document.getElementById('keywordsList');
  kwEl.innerHTML = data.keywords.map(kw => `
    <span class="keyword-tag">
      ${kw} <span class="remove" onclick="removeKeyword('${kw}')">&times;</span>
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
        <td><span class="status-pill ${statusClass}" style="display:inline-flex"><span class="pulse"></span> ${statusText}</span></td>
      </tr>
    `;
  }).join('');

  if (retailers.length === 0) {
    perfBody.innerHTML = '<tr><td colspan="6" style="color:#666;text-align:center">No data yet — polls haven\'t run</td></tr>';
  }

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

// ─── Event Type definitions ──────────────────────────────────────
const EVENT_TYPES = [
  { key: 'RESTOCK',         color: '#57f287', label: 'Restock',         desc: 'Product goes from out-of-stock to in-stock' },
  { key: 'NEW_SKU',         color: '#5865f2', label: 'New Product',     desc: 'Product seen for the first time' },
  { key: 'PRICE_CHANGE',    color: '#ed4245', label: 'Price Change',    desc: 'Product price differs from last check' },
  { key: 'PREORDER_LIVE',   color: '#fe7434', label: 'Pre-Order Live',  desc: 'Pre-order becomes available' },
  { key: 'CART_AVAILABLE',  color: '#3498db', label: 'Cart Available',  desc: 'Add-to-cart becomes available' },
  { key: 'SHIPPING_CHANGE', color: '#95a5a6', label: 'Shipping Update', desc: 'Ships-to-home becomes available' },
];

// ─── Channels Tab ────────────────────────────────────────────────

async function loadChannels() {
  try {
    channelsData = await api('/channels');
  } catch {
    channelsData = { tiers: { paid: { delay: 0, channels: {} }, free: { delay: 45000, channels: {} } }, retailerChannels: {}, roles: { categories: {}, retailers: {} }, webhooks: {}, enabledEvents: {} };
  }

  const c = channelsData;

  // Event type toggles
  const enabled = c.enabledEvents || {};
  const evtGrid = document.getElementById('eventTypesGrid');
  evtGrid.innerHTML = EVENT_TYPES.map(evt => {
    const on = enabled[evt.key] !== false; // default to true if not set
    return `
      <div class="evt-card">
        <div class="evt-dot" style="background:${evt.color}"></div>
        <div class="evt-info">
          <div class="evt-name">${evt.label}</div>
          <div class="evt-desc">${evt.desc}</div>
        </div>
        <label class="evt-toggle">
          <input type="checkbox" id="evt-${evt.key}" ${on ? 'checked' : ''} />
          <span class="slider"></span>
        </label>
      </div>
    `;
  }).join('');

  // Tier delays
  setVal('ch-paid-delay', c.tiers?.paid?.delay || 0);
  setVal('ch-free-delay', c.tiers?.free?.delay || 45000);

  // Paid category channels
  const paidCh = c.tiers?.paid?.channels || {};
  setVal('ch-paid-default', paidCh.default || '');
  setVal('ch-paid-pokemon', paidCh.pokemon || '');
  setVal('ch-paid-onepiece', paidCh.onepiece || '');
  setVal('ch-paid-dragonball', paidCh.dragonball || '');
  setVal('ch-paid-naruto', paidCh.naruto || '');
  setVal('ch-paid-lorcana', paidCh.lorcana || '');
  setVal('ch-paid-yugioh', paidCh.yugioh || '');
  setVal('ch-paid-mtg', paidCh.mtg || '');

  // Free category channels
  const freeCh = c.tiers?.free?.channels || {};
  setVal('ch-free-default', freeCh.default || '');
  setVal('ch-free-pokemon', freeCh.pokemon || '');
  setVal('ch-free-onepiece', freeCh.onepiece || '');
  setVal('ch-free-dragonball', freeCh.dragonball || '');
  setVal('ch-free-naruto', freeCh.naruto || '');
  setVal('ch-free-lorcana', freeCh.lorcana || '');
  setVal('ch-free-yugioh', freeCh.yugioh || '');
  setVal('ch-free-mtg', freeCh.mtg || '');

  // Retailer channel overrides
  const retCh = c.retailerChannels || {};
  const retGrid = document.getElementById('retailerChannelsGrid');
  const enabledRetailers = retailersList.filter(r => r.enabled);
  retGrid.innerHTML = enabledRetailers.map(r => `
    <div class="routing-card" style="padding:12px">
      <div class="routing-row" style="margin:0">
        <label style="min-width:120px;font-weight:500;color:#fafafa">${r.name}</label>
        <input type="text" id="rch-${r.id}" value="${retCh[r.id] || ''}" placeholder="Channel ID (optional)" />
      </div>
    </div>
  `).join('');

  // Category roles
  const catRoles = c.roles?.categories || {};
  setVal('role-cat-pokemon', catRoles.pokemon || '');
  setVal('role-cat-onepiece', catRoles.onepiece || '');
  setVal('role-cat-dragonball', catRoles.dragonball || '');
  setVal('role-cat-naruto', catRoles.naruto || '');
  setVal('role-cat-lorcana', catRoles.lorcana || '');
  setVal('role-cat-yugioh', catRoles.yugioh || '');
  setVal('role-cat-mtg', catRoles.mtg || '');

  // Retailer roles
  const retRoles = c.roles?.retailers || {};
  const retRolesGrid = document.getElementById('retailerRolesGrid');
  retRolesGrid.innerHTML = enabledRetailers.slice(0, 10).map(r => `
    <div class="routing-row">
      <label>${r.name}</label>
      <input type="text" id="role-ret-${r.id}" value="${retRoles[r.id] || ''}" placeholder="Role ID" />
    </div>
  `).join('');

  // Global roles
  setVal('role-paidMember', c.roles?.paidMember || '');
  setVal('role-allAlerts', c.roles?.allAlerts || '');

  // Webhooks
  setVal('wh-paid', c.webhooks?.paid_default || '');
  setVal('wh-free', c.webhooks?.free_default || '');

  // Watchlist + Admin
  setVal('ch-watchlist', c.watchlistChannel || '');
  setVal('ch-admin', c.adminChannel || '');
}

async function saveChannels() {
  const categories = ['pokemon', 'onepiece', 'dragonball', 'naruto', 'lorcana', 'yugioh', 'mtg'];

  const paidChannels = { default: getVal('ch-paid-default') };
  const freeChannels = { default: getVal('ch-free-default') };
  categories.forEach(cat => {
    paidChannels[cat] = getVal(`ch-paid-${cat}`);
    freeChannels[cat] = getVal(`ch-free-${cat}`);
  });

  // Retailer channel overrides
  const retailerChannels = {};
  const enabledRetailers = retailersList.filter(r => r.enabled);
  enabledRetailers.forEach(r => {
    const el = document.getElementById(`rch-${r.id}`);
    if (el) retailerChannels[r.id] = el.value.trim();
  });

  // Category roles
  const catRoles = {};
  categories.forEach(cat => { catRoles[cat] = getVal(`role-cat-${cat}`); });

  // Retailer roles
  const retRoles = {};
  enabledRetailers.slice(0, 10).forEach(r => {
    const el = document.getElementById(`role-ret-${r.id}`);
    if (el) retRoles[r.id] = el.value.trim();
  });

  // Event type toggles
  const enabledEvents = {};
  EVENT_TYPES.forEach(evt => {
    const el = document.getElementById(`evt-${evt.key}`);
    enabledEvents[evt.key] = el ? el.checked : true;
  });

  const config = {
    tiers: {
      paid: { delay: parseInt(getVal('ch-paid-delay')) || 0, channels: paidChannels },
      free: { delay: parseInt(getVal('ch-free-delay')) || 45000, channels: freeChannels },
    },
    retailerChannels,
    enabledEvents,
    roles: {
      categories: catRoles,
      retailers: retRoles,
      paidMember: getVal('role-paidMember'),
      allAlerts: getVal('role-allAlerts'),
    },
    watchlistChannel: getVal('ch-watchlist'),
    adminChannel: getVal('ch-admin'),
    webhooks: {
      paid_default: getVal('wh-paid'),
      free_default: getVal('wh-free'),
    },
  };

  try {
    await api('/channels', { method: 'PUT', body: JSON.stringify(config) });
    log('Channel config saved');
    const msg = document.getElementById('savedMsg');
    msg.classList.add('show');
    setTimeout(() => msg.classList.remove('show'), 3000);
  } catch (err) {
    log('Failed to save channels: ' + err.message);
  }
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

// ─── Products ────────────────────────────────────────────────────

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

// ─── Scan & Resend ───────────────────────────────────────────────

async function triggerScan() {
  const hours = parseInt(document.getElementById('scanWindow').value);
  const btn = document.getElementById('scanBtn');
  const resultsDiv = document.getElementById('scanResults');
  const summaryDiv = document.getElementById('scanSummary');
  const breakdownDiv = document.getElementById('scanBreakdown');

  btn.disabled = true;
  btn.textContent = 'Scanning...';
  resultsDiv.style.display = 'none';

  try {
    const results = await api('/scan', {
      method: 'POST',
      body: JSON.stringify({ hours }),
    });

    summaryDiv.textContent = `Sent ${results.totalSent} products across ${results.retailers.length} retailers (${hours}h window)`;

    breakdownDiv.innerHTML = results.retailers.map(r => {
      const pct = r.found > 0 ? Math.round((r.sent / r.found) * 100) : 0;
      const barColor = r.sent > 0 ? '#9b59b6' : '#27272a';
      return `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:13px">
          <span style="min-width:140px;color:#fafafa;font-weight:500">${r.name}</span>
          <span style="min-width:80px;color:#a1a1aa">${r.sent}/${r.found}</span>
          <div style="flex:1;height:4px;border-radius:2px;background:#27272a;overflow:hidden">
            <div style="width:${pct}%;height:100%;border-radius:2px;background:${barColor};transition:width 0.3s"></div>
          </div>
        </div>
      `;
    }).join('');

    resultsDiv.style.display = 'block';
    log(`Scan complete: ${results.totalSent} products sent (${hours}h window)`);
  } catch (err) {
    log(`Scan failed: ${err.message}`);
    summaryDiv.textContent = `Scan failed: ${err.message}`;
    breakdownDiv.innerHTML = '';
    resultsDiv.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan & Resend';
  }
}

// ─── Proxies Tab ─────────────────────────────────────────────────

async function loadProxies() {
  const stats = await api('/stats/proxy');
  const pool = stats.proxyPool || [];

  const healthy = pool.filter(p => p.healthy && p.requests > 0).length;
  const blocked = pool.filter(p => p.blocked > 0 && !p.healthy).length;
  const idle = pool.filter(p => p.requests === 0 && p.healthy).length;
  document.getElementById('proxyPoolCount').textContent = `${healthy} active / ${blocked} cooldown / ${idle} idle`;

  const grid = document.getElementById('proxyGrid');
  const maxReqs = Math.max(1, ...pool.map(p => p.requests));

  grid.innerHTML = pool.map(p => {
    const ip = p.url.split('@')[1] || p.url;
    const state = p.blocked > 0 && !p.healthy ? 'blocked' : p.requests > 0 ? 'healthy' : 'idle';
    const cooldownMin = Math.ceil(p.cooldownRemaining / 60000);
    const cooldownText = cooldownMin > 0 ? `<div class="proxy-cooldown">Cooldown: ${cooldownMin} min remaining</div>` : '';
    const barWidth = (p.requests / maxReqs * 100).toFixed(0);
    const assignLabel = p.assignedTo
      ? `<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:#27272a;color:#a1a1aa;font-weight:500;text-transform:uppercase;letter-spacing:0.5px">${p.assignedTo}</span>`
      : '<span style="font-size:10px;color:#3f3f46">unassigned</span>';

    return `
      <div class="proxy-card ${state}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="proxy-ip">#${p.index} ${ip}</div>
          <span class="status-pill ${state === 'blocked' ? 'bad' : state === 'healthy' ? 'ok' : 'off'}" style="font-size:11px;padding:2px 8px">
            <span class="pulse"></span> ${state === 'blocked' ? 'Cooldown' : state === 'healthy' ? 'Active' : 'Idle'}
          </span>
        </div>
        <div class="proxy-status">
          <span>Assigned: ${assignLabel}</span>
          <span>Requests: <span class="val">${p.requests}</span></span>
          <span>Blocked: <span class="val">${p.blocked}</span></span>
        </div>
        ${cooldownText}
        <div class="proxy-bar"><div class="fill" style="width:${barWidth}%;${state === 'blocked' ? 'background:#f87171' : ''}"></div></div>
      </div>
    `;
  }).join('');

  // Proxy retailer assignment table
  const ispRetailers = retailersList.filter(r => r.proxyTier === 'isp');
  const tbody = document.getElementById('proxyRetailerTable');
  tbody.innerHTML = ispRetailers.map(r => {
    const d = stats.byRetailer?.[r.id] || { requests: 0, blocked: 0 };
    const blockRate = d.requests > 0 ? ((d.blocked / d.requests) * 100).toFixed(1) : '0';
    const statusClass = d.blocked === 0 ? 'ok' : parseFloat(blockRate) > 50 ? 'bad' : 'warn';
    const statusText = d.blocked === 0 ? 'Clean' : parseFloat(blockRate) > 50 ? 'Struggling' : 'Partial';
    return `
      <tr>
        <td>${r.name}</td>
        <td><span style="color:#60a5fa;font-weight:500">ISP</span></td>
        <td>${d.requests}</td>
        <td>${d.blocked}</td>
        <td>${blockRate}%</td>
        <td><span class="status-pill ${statusClass}" style="display:inline-flex;font-size:11px;padding:2px 8px"><span class="pulse"></span> ${statusText}</span></td>
      </tr>
    `;
  }).join('');

  if (ispRetailers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:#52525b;text-align:center">No retailers using ISP proxies</td></tr>';
  }
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// Live auto-refresh
setInterval(() => {
  if (apiKey) {
    loadHealth();
    loadStats();
  }
}, 10000);

setInterval(() => {
  if (apiKey) {
    loadRetailers();
    loadProducts();
  }
}, 30000);
