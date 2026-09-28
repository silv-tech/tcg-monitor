/**
 * Side panel — the only place a human decides what this is allowed to buy.
 *
 * Two switches, and the difference between them matters:
 *
 *   Listening   the kill switch. Off means no triggers are consumed at all. This is what someone
 *               reaches for when something is visibly wrong, so it is checked first, every time.
 *   Place orders automatically   whether a verified checkout is actually submitted. Off still
 *               opens the tab and does the work, but stops at review for a human to finish.
 *
 * Both start OFF on a fresh install, and stay off until switched on deliberately.
 */

const DEFAULTS = {
  baseUrl: '', apiKey: '', armed: false, autoSubmit: false, items: [], cursor: 0, acoLog: [],
};

const $ = (id) => document.getElementById(id);
const get = () => chrome.storage.local.get(DEFAULTS);

function renderItems(items) {
  const box = $('items');
  $('itemCount').textContent = items.length;
  $('itemCount').className = `pill${items.length ? ' on' : ''}`;
  box.innerHTML = '';
  if (items.length === 0) {
    box.innerHTML = '<div class="empty">No saved items yet — add one below.</div>';
    return;
  }
  items.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'item';
    const unver = it.allowUnverifiedSeller ? ' · any seller' : '';
    const pin = it.offerId ? ' · pinned offer' : '';
    d.innerHTML = `
      <div class="row">
        <div>
          <div class="name">${escapeHtml(it.name || it.asin)}</div>
          <div class="meta">${escapeHtml(it.asin)} · x${it.quantity || 1} · max $${it.maxPrice}${pin}${unver}</div>
        </div>
        <button data-rm="${i}">Remove</button>
      </div>`;
    box.appendChild(d);
  });
  box.querySelectorAll('[data-rm]').forEach(b => {
    b.addEventListener('click', async () => {
      const { items: cur } = await get();
      cur.splice(Number(b.dataset.rm), 1);
      await chrome.storage.local.set({ items: cur });
    });
  });
}

// Item names come from the monitor, which gets them from Amazon. Never trust them as markup.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderLog(entries) {
  const box = $('log');
  box.innerHTML = '';
  if (!entries || entries.length === 0) {
    box.innerHTML = '<div style="border:0">Nothing yet.</div>';
    return;
  }
  for (const e of entries) {
    const d = document.createElement('div');
    const t = (e.at || '').slice(11, 19);
    const what = e.error ? `ERROR ${e.error}` : (e.note || '');
    d.textContent = `${t}  ${e.asin ? e.asin + '  ' : ''}${what}`;
    if (e.error) d.style.color = '#e8483f';
    else if (/BUYING|ordered/.test(what)) d.style.color = '#3fb950';
    box.appendChild(d);
  }
}

async function refresh() {
  const c = await get();
  $('baseUrl').value = c.baseUrl;
  $('apiKey').value = c.apiKey;
  $('armed').checked = !!c.armed;
  $('autoSubmit').checked = !!c.autoSubmit;
  $('armWarn').hidden = !(c.armed && c.autoSubmit);
  renderItems(c.items || []);
  renderLog(c.acoLog || []);

  chrome.runtime.sendMessage({ type: 'aco-status' }, (s) => {
    if (chrome.runtime.lastError || !s) { $('listenSub').textContent = 'Worker asleep'; return; }
    if (!s.armed) $('listenSub').textContent = 'Off — no triggers are being read';
    else if (s.backoffUntil > Date.now()) {
      const mins = Math.ceil((s.backoffUntil - Date.now()) / 60000);
      $('listenSub').textContent = `Paused ${mins}min — Amazon showed a challenge`;
    } else $('listenSub').textContent = s.polling
      ? `Live · watching ${s.items} item(s)`
      : 'Connecting…';
  });
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    baseUrl: $('baseUrl').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
  });
  $('save').textContent = 'Saved';
  setTimeout(() => { $('save').textContent = 'Save'; }, 1200);
});

$('kick').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'aco-kick' }, refresh));

$('armed').addEventListener('change', () => chrome.storage.local.set({ armed: $('armed').checked }));
$('autoSubmit').addEventListener('change', () => chrome.storage.local.set({ autoSubmit: $('autoSubmit').checked }));

// One control that stops everything, without unpicking per-item settings.
$('stopAll').addEventListener('click', () => chrome.storage.local.set({ armed: false, autoSubmit: false }));

$('add').addEventListener('click', async () => {
  const asin = $('fAsin').value.trim().toUpperCase();
  const maxPrice = Number($('fMax').value);
  if (!/^[A-Z0-9]{10}$/.test(asin)) return flash('ASIN must be 10 characters.');
  // Refused at the door rather than at checkout: an item with no ceiling is an open chequebook,
  // and guards.js would only ever refuse to buy it — better to never save it.
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) return flash('Max price is required.');

  const { items } = await get();
  if (items.some(i => i.asin === asin)) return flash('That ASIN is already saved.');

  items.push({
    asin,
    name: $('fName').value.trim(),
    // Stored exactly as pasted. buyNowUrl detects whether it is already percent-encoded, so a
    // token copied straight out of a Discord alert works without the user thinking about it.
    offerId: $('fOffer').value.trim(),
    quantity: Math.max(1, Math.min(12, Number($('fQty').value) || 1)),
    maxPrice,
    allowUnverifiedSeller: $('fUnverified').checked,
  });
  await chrome.storage.local.set({ items });
  $('fAsin').value = ''; $('fName').value = ''; $('fMax').value = ''; $('fOffer').value = '';
  $('fUnverified').checked = false;
});

function flash(msg) {
  const b = $('add');
  const was = b.textContent;
  b.textContent = msg;
  setTimeout(() => { b.textContent = was; }, 1800);
}

$('export').addEventListener('click', async () => {
  const { items } = await get();
  await navigator.clipboard.writeText(JSON.stringify(items, null, 2));
  const b = $('export');
  b.textContent = 'Copied to clipboard';
  setTimeout(() => { b.textContent = 'Export saved items'; }, 1500);
});

$('import').addEventListener('click', async () => {
  let raw = '';
  try { raw = await navigator.clipboard.readText(); } catch { return flash('Clipboard blocked.'); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return flash('Clipboard is not JSON.'); }
  if (!Array.isArray(parsed)) return flash('Expected a list of items.');
  // Re-validate on the way in. An imported row with no ceiling would sit there looking armed and
  // silently never buy — worse than refusing it.
  const clean = parsed.filter(i => i && /^[A-Z0-9]{10}$/i.test(String(i.asin || ''))
    && Number(i.maxPrice) > 0)
    .map(i => ({
      asin: String(i.asin).toUpperCase(),
      name: String(i.name || ''),
      offerId: String(i.offerId || ''),
      quantity: Math.max(1, Math.min(12, Number(i.quantity) || 1)),
      maxPrice: Number(i.maxPrice),
      allowUnverifiedSeller: i.allowUnverifiedSeller === true,
    }));
  await chrome.storage.local.set({ items: clean });
  flash(`Imported ${clean.length} of ${parsed.length}`);
});

$('clearLog').addEventListener('click', () => chrome.storage.local.set({ acoLog: [] }));

chrome.storage.onChanged.addListener(refresh);
refresh();
setInterval(refresh, 4000);
