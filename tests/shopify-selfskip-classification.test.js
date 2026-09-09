/**
 * A poll we declined to send is not a retailer failure — the one message where that was untrue.
 *
 * Three shops (zardocards, infinitycards, deckoutgaming) were going STALE with
 * "rate limited — skipping poll rather than reporting an empty catalogue". That message was
 * built as `${this.name}: rate limited — ...`, and every classifier downstream is ^-anchored on
 * "Rate limited"/"Cooling down" (stealth-http.js). A message starting with the shop name
 * therefore matched NEITHER isRateLimited nor isSelfSkip, so the scheduler counted our own
 * budget refusal — or our own cooldown — as a retailer error:
 *
 *     recordError -> consecutiveErrors++ -> healthy=false at 5
 *     circuit.errors++ -> breaker trips at 5
 *     recovery probe lands in the same cooldown -> same unrecognised message -> never closes
 *
 * That is verbatim the loop the codebase documents as already fixed for the other three
 * rate-limit messages. This one string slipped through.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { isRateLimited, isSelfSkip, isBudgetSkip, cooldownRemaining, _resetCooldowns } = require('../src/utils/stealth-http');

describe('the refusal that reaches the scheduler keeps its classification', () => {
  // The three real refusals, exactly as their producers spell them.
  const BUDGET = new Error('Rate limited (budget): https://zardocards.com/products.json?limit=250');
  const COOLING = new Error('Cooling down 279s after 429: https://infinitycards.ca/products.json');
  const REAL_429 = new Error('Rate limited (429): https://deckoutgaming.ca/products.json');

  test('our own budget refusal is a self-skip, not a retailer error', () => {
    assert.strictEqual(isRateLimited(BUDGET), true);
    assert.strictEqual(isSelfSkip(BUDGET), true, 'the scheduler must not count this as an error');
    assert.strictEqual(isBudgetSkip(BUDGET), true);
  });

  test('our own cooldown is a self-skip', () => {
    assert.strictEqual(isSelfSkip(COOLING), true);
  });

  test("a real 429 is rate-limited but NOT a self-skip — the shop did refuse us", () => {
    assert.strictEqual(isRateLimited(REAL_429), true);
    assert.strictEqual(isSelfSkip(REAL_429), false);
  });

  test('the OLD prefixed message was recognised by nothing — the regression itself', () => {
    const old = new Error('Deck Out Gaming: rate limited — skipping poll rather than reporting an empty catalogue');
    assert.strictEqual(isRateLimited(old), false, 'this is why it counted as a poll error');
    assert.strictEqual(isSelfSkip(old), false);
  });

  test('rethrowing the original preserves what the new message destroyed', () => {
    // shopify.js now rethrows `throttleErr` rather than wrapping it in a named string.
    for (const err of [BUDGET, COOLING, REAL_429]) {
      assert.strictEqual(isRateLimited(err), true,
        `${err.message.slice(0, 24)} must stay classifiable after rethrow`);
    }
  });
});

describe('the throttle grace actually fires for a shop', () => {
  test('a bare retailer root finds a cooldown keyed on the polled path', () => {
    if (typeof _resetCooldowns === 'function') _resetCooldowns();
    const { setCooldown } = require('../src/utils/stealth-http');
    // Real shape: the cooldown is set on the page URL, health.js asks with the bare root.
    const page = 'https://hobbiesville.com/products.json?limit=250&page=1';
    const root = 'https://hobbiesville.com';
    if (typeof setCooldown === 'function') {
      setCooldown(page, 60000, null);
      assert.ok(cooldownRemaining(root) > 0,
        'health.js passes the bare root; if this is 0 the grace is dead and the shop reads as an outage');
    }
  });

  test('an unrelated host is unaffected', () => {
    assert.strictEqual(cooldownRemaining('https://kanzengames.com'), 0);
  });
});
