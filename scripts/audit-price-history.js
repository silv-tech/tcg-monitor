#!/usr/bin/env node
/**
 * Price-history integrity audit.
 *
 * Written after a real incident: Amazon's search parser took the first price in a card's
 * slice, which for a listing with no price of its own picked up a neighbouring sponsored
 * product's price. That fabricated prices, made inStock true, and fired false RESTOCK alerts.
 * 268 Amazon price-history keys had to be purged.
 *
 * The signature of that bug is unmistakable in stored history: a product oscillating between
 * two unrelated values poll after poll (699.99 -> 39.98 -> 12.99 -> 39.98 -> 12.99), which no
 * real retail price does. This checks every store for it.
 *
 * Run it before a release, and any time a price parser changes.
 *
 *   node scripts/audit-price-history.js          # report only
 *   node scripts/audit-price-history.js --purge amazon
 *
 * Must run where REDIS_URL resolves — on Railway that means `railway ssh` inside the app.
 */

const Redis = require('ioredis');

const STORES = ['amazon', 'walmart', 'costco', 'bestbuy', 'ebgames', 'pokemoncenter'];
const SWING_RATIO = 3;      // max/min beyond this is not a normal retail move
const OSCILLATION_MIN = 3;  // times a value must recur alternating to look like parser flapping

async function scanKeys(redis, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

/** True when the series flips back and forth between a small set of values. */
function looksOscillating(prices) {
  if (prices.length < 4) return false;
  const counts = new Map();
  for (const p of prices) counts.set(p, (counts.get(p) || 0) + 1);
  const repeated = [...counts.values()].filter((c) => c >= OSCILLATION_MIN);
  return repeated.length >= 2;
}

async function main() {
  const purgeTarget = process.argv.includes('--purge')
    ? process.argv[process.argv.indexOf('--purge') + 1]
    : null;

  const redis = new Redis(process.env.REDIS_URL);
  let exitCode = 0;

  for (const store of STORES) {
    const keys = await scanKeys(redis, `tcg:pricehistory:${store}:*`);
    let withHistory = 0;
    let suspicious = 0;
    const samples = [];

    for (const key of keys) {
      let history = [];
      try { history = JSON.parse((await redis.get(key)) || '[]'); } catch { /* skip */ }
      if (history.length < 2) continue;
      withHistory++;

      const prices = history.map((h) => h.price).filter((p) => typeof p === 'number' && p > 0);
      if (prices.length < 2) continue;
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const bad = max / min > SWING_RATIO || looksOscillating(prices);
      if (bad) {
        suspicious++;
        if (samples.length < 3) samples.push(`${key.split(':').pop()} => ${prices.join(' -> ')}`);
      }
    }

    const flag = suspicious > 0 ? 'SUSPICIOUS' : 'ok';
    console.log(`${store.padEnd(14)} keys=${String(keys.length).padStart(4)}  withHistory=${String(withHistory).padStart(4)}  suspicious=${String(suspicious).padStart(3)}  ${flag}`);
    samples.forEach((s) => console.log(`    ${s}`));
    if (suspicious > 0) exitCode = 1;

    if (purgeTarget === store && keys.length > 0) {
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 200) deleted += await redis.del(...keys.slice(i, i + 200));
      console.log(`    PURGED ${deleted} keys for ${store}`);
    }
  }

  if (exitCode) {
    console.log('\nSuspicious history means a price parser is probably reading the wrong element.');
    console.log('Fix the parser first — purging alone just lets it refill with bad data.');
  }
  await redis.quit();
  process.exit(exitCode);
}

main().catch((err) => { console.error(err); process.exit(2); });
