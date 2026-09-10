const DEFAULTS = {
  baseUrl: '', apiKey: '', batchSize: 20, concurrency: 2, cycleDelaySec: 5, enabled: false,
};
const FIELDS = ['baseUrl', 'apiKey', 'batchSize', 'concurrency', 'cycleDelaySec'];

function renderLog(entries) {
  const box = document.getElementById('log');
  box.innerHTML = '<strong>Recent activity</strong>';
  for (const e of entries || []) {
    const d = document.createElement('div');
    const t = (e.at || '').slice(11, 19);
    if (e.error) d.textContent = `${t}  ERROR  ${e.error}`;
    else if (e.note) d.textContent = `${t}  ${e.note}`;
    else d.textContent = `${t}  pushed ${e.pushed} — ${e.accepted ?? '?'} read`
      + `${e.changed ? `, ${e.changed} changed` : ''}${e.rejected ? `, ${e.rejected} rejected` : ''}`
      + `${e.status && e.status !== 200 ? `  [HTTP ${e.status}]` : ''}`;
    box.appendChild(d);
  }
}

chrome.storage.local.get({ ...DEFAULTS, pushLog: [] }, (c) => {
  for (const f of FIELDS) document.getElementById(f).value = c[f];
  document.getElementById('enabled').checked = !!c.enabled;
  renderLog(c.pushLog);
});

chrome.storage.onChanged.addListener((ch) => {
  if (ch.pushLog) renderLog(ch.pushLog.newValue);
});

document.getElementById('save').addEventListener('click', () => {
  const out = { enabled: document.getElementById('enabled').checked };
  for (const f of FIELDS) {
    const v = document.getElementById(f).value;
    out[f] = typeof DEFAULTS[f] === 'number' ? Math.max(1, Number(v) || DEFAULTS[f]) : v.trim();
  }
  // Ceilings, not suggestions: this decides how hard a real browser hits a bot-scored site.
  out.concurrency = Math.min(6, out.concurrency);
  out.batchSize = Math.min(200, out.batchSize);
  chrome.storage.local.set(out, () => {
    const b = document.getElementById('save');
    b.textContent = 'Saved';
    setTimeout(() => { b.textContent = 'Save'; }, 1200);
  });
});

document.getElementById('refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'pc-refresh' });
});
