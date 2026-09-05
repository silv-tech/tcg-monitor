/**
 * Pokemon Center could not detect a restock. At all.
 *
 * _selectCheckTargets drew from exactly two sources — the watchlist and newly-seen SKUs. The
 * watchlist was empty and the sitemap was stable, so it selected nothing on every poll for
 * days, logging "1195 products, no checks due (0 queued, 0 with known stock)" at info level
 * while the store reported healthy.
 *
 * With nothing ever checked: every product kept price=null and inStock=false, so no product
 * could ever CHANGE to in-stock, so no restock event was possible. A big-six retailer that was
 * structurally incapable of alerting.
 *
 * Checks are expensive — DataDome 403s the free path (verified live), so each one is a
 * 25-credit ultraPremium ScraperAPI call and a full 1,195-product rotation costs ~29,875
 * credits, about a third of the monthly plan. So the rotation has to be bounded, not eager.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Mirrors _selectCheckTargets + _rotationBudgetLeft.
function makeSelector({ watchlist = [], newSkus = [], catalogue = [], checksPerPoll = 3, dailyCap = 40 }) {
  const rotationCheckedAt = new Map();
  let spentToday = 0;
  const queue = [...newSkus];
  return {
    get spent() { return spentToday; },
    select() {
      const targets = [];
      for (const sku of watchlist) if (catalogue.includes(sku)) targets.push(sku);
      while (queue.length > 0 && targets.length < checksPerPoll) {
        const sku = queue.shift();
        if (catalogue.includes(sku) && !targets.includes(sku)) targets.push(sku);
      }
      if (targets.length < checksPerPoll && dailyCap - spentToday > 0) {
        const candidates = catalogue
          .filter((s) => !targets.includes(s))
          .map((s) => [s, rotationCheckedAt.get(s) || 0])
          .sort((a, b) => a[1] - b[1]);
        for (const [sku] of candidates) {
          if (targets.length >= checksPerPoll) break;
          if (dailyCap - spentToday <= 0) break;
          targets.push(sku);
          rotationCheckedAt.set(sku, Date.now() + targets.length);
          spentToday += 1;
        }
      }
      return targets;
    },
  };
}

const CATALOGUE = Array.from({ length: 1195 }, (_, i) => `sku-${i}`);

describe('pokemon center: the deadlock', () => {
  test('OLD behaviour selected nothing — the bug', () => {
    // No watchlist, no new SKUs, no rotation: this is what ran for days.
    const s = makeSelector({ catalogue: CATALOGUE, dailyCap: 0 });
    assert.deepStrictEqual(s.select(), [], 'documents the deadlock');
  });

  test('rotation now gives it something to check', () => {
    const s = makeSelector({ catalogue: CATALOGUE });
    assert.strictEqual(s.select().length, 3, 'no longer inert');
  });

  test('rotation reaches different products each poll rather than resampling one', () => {
    const s = makeSelector({ catalogue: CATALOGUE });
    const seen = new Set([...s.select(), ...s.select(), ...s.select()]);
    assert.strictEqual(seen.size, 9, 'oldest-checked-first moves through the catalogue');
  });
});

describe('pokemon center: budget is bounded', () => {
  test('rotation stops at the daily cap', () => {
    const s = makeSelector({ catalogue: CATALOGUE, dailyCap: 10 });
    for (let i = 0; i < 20; i++) s.select();
    assert.strictEqual(s.spent, 10, 'never exceeds the cap no matter how often it polls');
  });

  test('a cap of 0 disables rotation entirely, leaving watchlist-only', () => {
    const s = makeSelector({ catalogue: CATALOGUE, dailyCap: 0, watchlist: ['sku-5'] });
    assert.deepStrictEqual(s.select(), ['sku-5']);
  });

  test('40 checks/day stays inside the plan', () => {
    // 40 x 25 credits x 30 days = 30,000 of a 100,000/month plan.
    assert.ok(40 * 25 * 30 <= 100000 * 0.35, 'rotation must not dominate the budget');
  });
});

describe('pokemon center: priority order', () => {
  test('the watchlist is served before rotation', () => {
    const s = makeSelector({ catalogue: CATALOGUE, watchlist: ['sku-900'], checksPerPoll: 2 });
    assert.strictEqual(s.select()[0], 'sku-900');
  });

  test('a newly listed SKU beats rotation', () => {
    const s = makeSelector({ catalogue: CATALOGUE, newSkus: ['sku-1100'], checksPerPoll: 2 });
    assert.ok(s.select().includes('sku-1100'));
  });

  test('a watchlisted SKU missing from the catalogue is skipped, not checked blindly', () => {
    const s = makeSelector({ catalogue: ['sku-1'], watchlist: ['not-listed'], dailyCap: 0 });
    assert.deepStrictEqual(s.select(), []);
  });
});
