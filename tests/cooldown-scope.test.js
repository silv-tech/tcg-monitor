/**
 * A cooldown must not silence endpoints that were never throttled.
 *
 * Keying cooldowns on the HOST took Walmart's search offline on 2026-09-05. Its watchlist
 * polls a GraphQL endpoint on www.walmart.ca; when that returned 429, the host-wide cooldown
 * also blocked the search endpoint — a different API that was answering fine. Observed:
 *
 *   Stealth: rate limited on www.walmart.ca (strike 1) — quiet for 30s
 *   Walmart: search — 0/4 stealth, 0 products, 1ms
 *   Walmart Canada: found 0 products in 0ms      <- 0ms: never sent
 *
 * With the escalating ladder that is up to 15 minutes of a big-six store going blind because
 * of our own backoff.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const { setCooldown, cooldownRemaining, _resetCooldowns } = require('../src/utils/stealth-http');

afterEach(() => _resetCooldowns());

const WM_WATCHLIST = 'https://www.walmart.ca/orchestra/pdp/graphql/DynamicItemById/abc/ip/6000208831664?variables=%7B%7D';
const WM_SEARCH = 'https://www.walmart.ca/search?q=pokemon+booster+box';

describe('cooldown scope', () => {
  test('a 429 on Walmart watchlist does NOT silence Walmart search', () => {
    _resetCooldowns();
    setCooldown(WM_WATCHLIST, 5000);
    assert.ok(cooldownRemaining(WM_WATCHLIST) > 0, 'the throttled endpoint backs off');
    assert.strictEqual(cooldownRemaining(WM_SEARCH), 0, 'search must stay live');
  });

  test('the throttled endpoint still backs off properly', () => {
    _resetCooldowns();
    const { ms } = setCooldown(WM_WATCHLIST, 5000);
    assert.ok(ms >= 30000, 'escalating ladder still applies to the endpoint that 429d');
  });

  test('a shop keeps ONE cooldown across fast poll and full sweep', () => {
    // Both hit /products.json, only the query differs, so they must share a key — otherwise
    // the sweep would walk straight into a block the fast poll just discovered.
    _resetCooldowns();
    setCooldown('https://shop.example/products.json?limit=50&page=1', 5000);
    assert.ok(cooldownRemaining('https://shop.example/products.json?limit=250&page=3') > 0,
      'same endpoint, different query — still cooled down');
  });

  test('different shops never share a cooldown', () => {
    _resetCooldowns();
    setCooldown('https://shop-a.example/products.json', 5000);
    assert.strictEqual(cooldownRemaining('https://shop-b.example/products.json'), 0);
  });

  test('a collection endpoint is tracked separately from the catalogue endpoint', () => {
    _resetCooldowns();
    setCooldown('https://shop.example/collections/pokemon/products.json', 5000);
    assert.strictEqual(cooldownRemaining('https://shop.example/products.json'), 0);
  });

  test('every big-six endpoint stays independent of the others', () => {
    _resetCooldowns();
    setCooldown('https://www.walmart.ca/orchestra/pdp/graphql/x/ip/1', 5000);
    for (const url of [
      'https://www.walmart.ca/search?q=pokemon',
      'https://www.amazon.ca/s?k=pokemon',
      'https://gdx-api.costco.com/catalog/search/api/v1/search',
      'https://www.bestbuy.ca/api/v2/json/search',
      'https://www.ebgames.ca/collections/pokemon',
      'https://www.pokemoncenter.com/api/products',
    ]) {
      assert.strictEqual(cooldownRemaining(url), 0, `${url} was wrongly silenced`);
    }
  });
});
