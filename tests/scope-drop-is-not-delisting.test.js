/**
 * A row removed by OUR scope filter is not a row the shop stopped selling.
 *
 * Conflating those two facts manufactures restocks, and it has now done so twice in production:
 *
 *   Titan Toyz  2026-09-11  isInScopeName() was called without extraGameNames, so every Dragon
 *                           Ball row was torn out of the carry-forward on each 8s partial poll.
 *                           2 SKUs alerted 37x in 9h.
 *
 *   ZardoCards  2026-09-13  The two gates read DIFFERENT STRINGS. Admission checks item.title
 *                           (shopify.js:714, :1204); the carry-forward checks cached.name. The
 *                           scope rule requires a franchise word, and measured on the live
 *                           names:
 *
 *                             isInScopeName('Base Set Unlimited Booster Pack')          false
 *                             isInScopeName('Pokemon Base Set Unlimited Booster Pack')  true
 *
 *                           All 29 flapping products failed bare and passed prefixed. So every
 *                           poll ADMITTED the product from its title and then declared it
 *                           delisted from its name: 30+ RESTOCKs in 20 minutes, the same SKUs
 *                           recurring 37s apart, until the alert limiter muted the whole store
 *                           and genuine restocks were dropped along with the noise.
 *
 * THE FIX IS THE INVARIANT, NOT THE STRINGS. Making the two gates agree today leaves the trap
 * armed for the next caller that passes a different one — which is exactly how the second
 * occurrence happened after the first was "fixed". Out-of-scope rows are simply not reported as
 * stale; they stop being touched and age out on their own TTL.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

// latin1: this file carries two intentional NUL bytes (offsets 2045, 2095) that a UTF-8 round
// trip destroys. Read it the way the repo's own tooling has to.
const SRC = fs.readFileSync(require.resolve('../src/core/poll-adapter'), 'latin1');

describe('the carry-forward records what it drops', () => {
  test('scope-dropped SKUs are collected, not silently lost', () => {
    assert.match(SRC, /const scopeDropped = new Set\(\);/,
      'the set must exist in pollAdapterOnce scope, above the partial-poll block');
    assert.match(SRC, /scopeDropped\.add\(sku\);/,
      'a row skipped for scope must be recorded as such');
  });

  test('the set is declared OUTSIDE the partial-poll branch', () => {
    // If it were declared inside `if (adapter._partialPoll ...)` it would be out of scope at the
    // stale-cleanup site and the filter below would throw on a full-sweep poll.
    const decl = SRC.indexOf('const scopeDropped = new Set();');
    const branch = SRC.indexOf('if (adapter._partialPoll &&');
    assert.ok(decl !== -1 && branch !== -1);
    assert.ok(decl < branch,
      'declaring it inside the branch would ReferenceError on every full sweep');
  });
});

describe('stale cleanup ignores scope-dropped rows', () => {
  test('staleSkus excludes them', () => {
    assert.match(SRC, /!\(sku in newProducts\) && !scopeDropped\.has\(sku\)/,
      'absence caused by our own filter must not count as absence from the shop');
  });

  test('the OOS-confirmation machinery is still intact for genuine absence', () => {
    // The fix must narrow what counts as stale, not disable the mechanism — a product the shop
    // really did delist still has to be confirmed out of stock.
    assert.match(SRC, /_missingStreak/, 'genuine absence is still streak-confirmed');
    assert.match(SRC, /streak >= OOS_CONFIRM_POLLS/, 'the confirmation threshold still applies');
    assert.match(SRC, /product\.inStock = false;/, 'confirmed absence still marks OOS');
  });
});

describe('the two scope gates that disagreed', () => {
  test('admission still reads item.title', () => {
    const shop = fs.readFileSync(require.resolve('../src/adapters/shopify'), 'utf8');
    assert.match(shop, /isInScopeName\(item\.title, this\.extraGameNames\)/,
      'admission is title-based; the carry-forward is name-based. They are allowed to disagree '
      + 'now — that is the point of the invariant — but the shapes must stay recognisable.');
  });

  test('the disagreement is real, and is what the invariant absorbs', () => {
    const { isInScopeName } = require('../src/utils/scope');
    // The live pair, from ZardoCards on 2026-09-13.
    assert.strictEqual(isInScopeName('Base Set Unlimited Booster Pack'), false,
      'the stored name lacks a franchise word');
    assert.strictEqual(isInScopeName('Pokemon Base Set Unlimited Booster Pack'), true,
      'the Shopify title carries one — this is the gap that fired 30+ false restocks');
  });
});

describe('the file survived patching', () => {
  test('both intentional NUL bytes are still at their documented offsets', () => {
    // poll-adapter.js has been corrupted by shell tooling before. Any edit that normalises
    // encoding silently destroys these, so the offsets are pinned here rather than trusted.
    const buf = fs.readFileSync(require.resolve('../src/core/poll-adapter'));
    const offsets = [];
    for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0) offsets.push(i);
    assert.deepStrictEqual(offsets, [2045, 2095],
      'the two NUL bytes must remain exactly where they are');
  });
});
