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

async function loadAll() {
  apiKey = document.getElementById('apiKey').value;
  try {
    await loadHealth();
    await loadRetailers();
    await loadProducts();
    await loadStats();
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
    el.textContent = data.status === 'ok' ? 'Healthy' : 'Degraded';
    el.className = `status ${data.status === 'ok' ? 'ok' : 'bad'}`;
    document.getElementById('statRetailers').textContent = data.retailers.length;
  } catch {
    document.getElementById('sysStatus').textContent = 'Down';
    document.getElementById('sysStatus').className = 'status bad';
  }
}

async function loadRetailers() {
  const retailers = await api('/retailers');
  const grid = document.getElementById('retailersGrid');
  grid.innerHTML = retailers.map(r => `
    <div class="card">
      <div class="name"><span class="health ${r.enabled ? 'green' : 'yellow'}"></span>${r.name}</div>
      <div class="meta">
        Interval: ${r.intervalMs / 1000}s &bull; Proxy: ${r.proxyTier}
        <br>
        <button class="toggle" onclick="toggleRetailer('${r.id}', ${!r.enabled})">
          ${r.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
    </div>
  `).join('');
}

async function toggleRetailer(id, enabled) {
  await api(`/retailers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  log(`${id} ${enabled ? 'enabled' : 'disabled'}`);
  await loadRetailers();
}

async function loadProducts() {
  const data = await api('/products');
  document.getElementById('statProducts').textContent = data.tracked.length;

  // Keywords
  const kwEl = document.getElementById('keywordsList');
  kwEl.innerHTML = data.keywords.map(kw => `
    <span style="display:inline-block;background:#333;padding:3px 10px;border-radius:12px;margin:3px;font-size:13px;">
      ${kw} <span style="cursor:pointer;color:#f87171;margin-left:4px;" onclick="removeKeyword('${kw}')">&times;</span>
    </span>
  `).join('');

  // SKUs
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
  document.getElementById('statRequests').textContent = stats.requests;
  document.getElementById('statBlocked').textContent = stats.blocked;
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

// Auto-refresh every 30s
setInterval(() => {
  if (apiKey) {
    loadHealth();
    loadStats();
  }
}, 30000);
