const DEFAULTS = { baseUrl: '', apiKey: '', intervalSec: 25, enabled: true };
const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  $('baseUrl').value = cfg.baseUrl;
  $('apiKey').value = cfg.apiKey;
  $('intervalSec').value = cfg.intervalSec;
  $('enabled').checked = cfg.enabled;
  renderLog();
}

async function renderLog() {
  const { pushLog = [] } = await chrome.storage.local.get('pushLog');
  const box = $('entries');
  if (pushLog.length === 0) { box.innerHTML = '<small>nothing yet</small>'; return; }
  box.innerHTML = '';
  for (const e of pushLog) {
    const div = document.createElement('div');
    const when = new Date(e.at).toLocaleTimeString();
    const ok = !e.error && e.status === 200;
    div.className = ok ? 'ok' : 'bad';
    div.textContent = ok
      ? `${when}  ${e.source}  ${e.parsed} parsed, ${e.known} known${e.seeded ? ' (seeded)' : ''}`
      : `${when}  ${e.source}  ${e.error || `HTTP ${e.status}: ${e.error || ''}`}`;
    box.appendChild(div);
  }
}

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    intervalSec: Math.max(5, Number($('intervalSec').value) || 25),
    enabled: $('enabled').checked,
  });
  $('saved').textContent = 'saved';
  setTimeout(() => { $('saved').textContent = ''; }, 1500);
});

chrome.storage.onChanged.addListener(renderLog);
load();
