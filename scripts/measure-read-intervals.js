/**
 * How often is a given product ACTUALLY re-read, per retailer?
 *
 * The confirmation guards in poll-adapter.js now count real observations instead of poll ticks,
 * so a confirmation window is no longer intervalMs — it is the retailer's true per-product
 * refresh interval. This measures that from production rather than deriving it from the code.
 *
 * METHOD. Every genuine build stamps product.lastSeen; every carry-forward path copies the row
 * untouched. A catalogue swept in rotation therefore carries lastSeen ages spread roughly
 * uniformly over one full cycle, so the upper percentiles of that age ARE the cycle length — the
 * interval between two real reads of the same SKU, which is what one confirmation step now costs.
 *
 * STRICTLY READ-ONLY: GET /api/state/:retailerId only. Never POST /api/scan, which resends cached
 * products to the client's live Discord.
 *
 * Run: node scripts/measure-read-intervals.js
 */
const HOST = process.env.TCG_HOST || 'https://jubilant-insight-production-49d0.up.railway.app';
const KEY = process.env.ADMIN_API_KEY;
if (!KEY) {
  console.error('set ADMIN_API_KEY in the environment (no key is baked into this file)');
  process.exit(1);
}

const RETAILERS = ['amazon', 'ebgames', 'walmart', 'costco', 'bestbuy', 'londondrugs',
  'hobbiesville', 'kanzengames', 'titantoyz', 'pokemoncenter'];

const OOS_CONFIRM_POLLS = Number(process.env.OOS_CONFIRM_POLLS) || 2;

const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);
const human = (ms) => {
  if (ms == null) return '   n/a';
  if (ms < 90_000) return `${(ms / 1000).toFixed(0)}s`.padStart(6);
  if (ms < 5_400_000) return `${(ms / 60_000).toFixed(1)}m`.padStart(6);
  return `${(ms / 3_600_000).toFixed(1)}h`.padStart(6);
};

(async () => {
  console.log(`\nhost: ${HOST}\n`);
  // Split by stock state, because the two directions carry different risk. An IN-STOCK row is one
  // that could sell out, so its read interval is the delay the OOS confirmation now adds. An
  // OUT-OF-STOCK row is one that could restock, and restocks are never held at all.
  console.log('                      IN STOCK (can sell out)        OUT OF STOCK (can restock)');
  console.log('retailer        noTs   rows    p25    p50    p90     rows    p50    p90');
  console.log('-'.repeat(84));

  const notes = [];
  for (const rid of RETAILERS) {
    let res;
    try {
      res = await fetch(`${HOST}/api/state/${rid}`, { headers: { 'x-api-key': KEY } });
    } catch (err) {
      notes.push(`${rid}: request failed — ${err.message}`);
      continue;
    }
    if (!res.ok) { notes.push(`${rid}: HTTP ${res.status}`); continue; }

    const body = await res.json();
    const products = Object.values(body.products || {});
    if (products.length === 0) { notes.push(`${rid}: no stored products`); continue; }

    const now = Date.now();
    const inAges = [];
    const oosAges = [];
    let noTs = 0;
    let frozen = 0;
    const stamps = new Map();
    for (const p of products) {
      if (typeof p.lastSeen !== 'number') { noTs++; continue; }
      const age = now - p.lastSeen;
      (p.inStock ? inAges : oosAges).push(age);
      stamps.set(p.lastSeen, (stamps.get(p.lastSeen) || 0) + 1);
    }
    // Many rows sharing one exact timestamp means they were stamped once and never re-stamped
    // since — a frozen signal, not a slow one. This is what the Shopify search lane produced.
    for (const n of stamps.values()) if (n > 20) frozen += n;

    inAges.sort((a, b) => a - b);
    oosAges.sort((a, b) => a - b);
    console.log(
      `${rid.padEnd(14)} ${String(noTs).padStart(5)}  ${String(inAges.length).padStart(5)}`
      + ` ${human(pct(inAges, 0.25))} ${human(pct(inAges, 0.5))} ${human(pct(inAges, 0.9))}`
      + `   ${String(oosAges.length).padStart(5)} ${human(pct(oosAges, 0.5))} ${human(pct(oosAges, 0.9))}`
      + (frozen ? `   <- ${frozen} rows share one timestamp (FROZEN)` : ''),
    );
  }

  if (notes.length) {
    console.log('\nnotes:');
    for (const n of notes) console.log(`  ${n}`);
  }
  console.log('\nnoTs is the count of rows with no numeric lastSeen. Those FAIL OPEN — they keep the');
  console.log('old poll-counting behaviour rather than freezing. They are not stuck.\n');
})().catch((e) => { console.error(e); process.exit(1); });
