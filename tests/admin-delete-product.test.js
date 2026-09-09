/**
 * Removing ONE product from a catalogue.
 *
 * Amazon repurposes ASINs. B0D2JGYX3F was stored as "Pokémon TCG: Gardevoir ex League Battle
 * Deck" at $81.87 while amazon.ca/dp/B0D2JGYX3F served a Nex Playground games console at
 * $399.96, and it reached a paying customer's channel. A census found 21 such rows. The only
 * removal tool was /retailers/:id/purge, which wipes all 613 — and on Amazon also empties the
 * store that boot hydration reloads from.
 *
 * Two defects this file exists to prevent, both found by review AFTER an earlier version of these
 * tests passed green:
 *
 *   1. ROUTE SHADOWING. The first version mounted this at /products/:retailerId/:sku, which sits
 *      in front of the existing /products/keywords/:keyword. Express takes the first match and
 *      this handler never calls next(), so DELETE /products/keywords/pokemon answered 200 "ok"
 *      while deleting nothing, and a keyword containing a space 400'd on the sku pattern.
 *      "pokemon", "pokemon tcg" and "booster box" are all live configured keywords.
 *
 *   2. A DELETE THAT UNDOES ITSELF. The route touched Redis only, but the adapter holds its
 *      catalogue in memory and republishes it every poll — on Amazon's 6s cadence the row came
 *      straight back. The delete reported success and changed nothing.
 *
 * Routing is asserted against the REAL router stack rather than over a socket. A live server
 * under `node --test` keeps the process alive after the assertions pass, so the runner marks the
 * whole FILE failed on timeout while every test inside it is green — a worse failure than the one
 * being tested for. Matching the stack directly is both faster and deterministic.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const state = require('../src/core/state');
state.getRedis = () => null;                 // keep ioredis out of this process
const scheduler = require('../src/core/scheduler');

let stored;
let deletedCalls;
let adapter;

state.getProduct = async (retailerId, sku) => stored[sku] || null;
state.getAllProducts = async () => stored;
state.deleteProduct = async (retailerId, sku) => { deletedCalls.push(`${retailerId}/${sku}`); };
scheduler.getAdapter = () => adapter;

const routes = require('../src/admin/routes');

/** The route Express would actually dispatch to, walking the real stack in order. */
function firstMatch(method, path) {
  for (const layer of routes.stack) {
    if (!layer.route) continue;
    if (!layer.route.methods[method.toLowerCase()]) continue;
    if (layer.match(path)) return layer.route.path;
  }
  return null;
}

/** Invoke the matched handler directly — no socket, no keep-alive, no hang. */
async function call(method, path, params) {
  const routePath = firstMatch(method, path);
  const layer = routes.stack.find((l) => l.route && l.route.path === routePath
    && l.route.methods[method.toLowerCase()]);
  assert.ok(layer, `no route matched ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;

  const res = { statusCode: 200, body: null };
  const fakeRes = {
    status(c) { res.statusCode = c; return fakeRes; },
    json(b) { res.body = b; return fakeRes; },
  };
  await handler({ params, body: {}, query: {} }, fakeRes, () => {});
  return res;
}

beforeEach(() => {
  deletedCalls = [];
  stored = { B0D2JGYX3F: { name: 'Pokémon TCG: Gardevoir ex League Battle Deck', price: 81.87 } };
  adapter = {
    _knownProducts: new Map([['B0D2JGYX3F', { sku: 'B0D2JGYX3F' }]]),
    _lastInStockAt: new Map([['B0D2JGYX3F', Date.now()]]),
  };
});

describe('it does not shadow the routes that were already there', () => {
  test('DELETE /products/keywords/:keyword still dispatches to its own handler', () => {
    assert.strictEqual(firstMatch('DELETE', '/products/keywords/pokemon'),
      '/products/keywords/:keyword',
      'mounted at /products/:retailerId/:sku this answered 200 "ok" and deleted nothing');
  });

  test('a keyword containing a space still dispatches correctly', () => {
    assert.strictEqual(firstMatch('DELETE', '/products/keywords/pokemon tcg'),
      '/products/keywords/:keyword',
      '"pokemon tcg" is a live configured keyword and 400d under the shadowing route');
  });

  test('DELETE /products/tracked/:retailer/:sku is untouched', () => {
    assert.strictEqual(firstMatch('DELETE', '/products/tracked/amazon/B0D2JGYX3F'),
      '/products/tracked/:retailer/:sku');
  });

  test('the catalogue delete owns its own path', () => {
    assert.strictEqual(firstMatch('DELETE', '/catalogue/amazon/B0D2JGYX3F'),
      '/catalogue/:retailerId/:sku');
  });

  test('no other DELETE route claims /catalogue', () => {
    const claimants = routes.stack
      .filter((l) => l.route && l.route.methods.delete && l.match('/catalogue/amazon/B0D2JGYX3F'))
      .map((l) => l.route.path);
    assert.deepStrictEqual(claimants, ['/catalogue/:retailerId/:sku']);
  });
});

describe('a single drifted product can be removed', () => {
  const CAT = '/catalogue/amazon/B0D2JGYX3F';

  test('the delete reaches state with the right retailer and sku', async () => {
    const res = await call('DELETE', CAT, { retailerId: 'amazon', sku: 'B0D2JGYX3F' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(deletedCalls, ['amazon/B0D2JGYX3F']);
  });

  test('it also evicts the row from the RUNNING adapter', async () => {
    const res = await call('DELETE', CAT, { retailerId: 'amazon', sku: 'B0D2JGYX3F' });
    assert.strictEqual(adapter._knownProducts.has('B0D2JGYX3F'), false,
      'without this the next poll republishes the row — the delete is a 6-second no-op');
    assert.strictEqual(adapter._lastInStockAt.has('B0D2JGYX3F'), false,
      'a dropped ASIN must not linger in the fast-poll lane');
    assert.strictEqual(res.body.evicted, true, 'and the caller is told it happened');
  });

  test('it reports whether the row was actually there', async () => {
    const hit = await call('DELETE', CAT, { retailerId: 'amazon', sku: 'B0D2JGYX3F' });
    const miss = await call('DELETE', CAT, { retailerId: 'amazon', sku: 'B0NOTHERE1' });
    assert.strictEqual(hit.body.existed, true);
    assert.strictEqual(miss.body.existed, false);
  });

  test('deleting an absent sku is idempotent, not an error', async () => {
    const res = await call('DELETE', CAT, { retailerId: 'amazon', sku: 'B0NOTHERE1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.ok, true);
  });

  test('a retailer with no running adapter still deletes from Redis', async () => {
    adapter = null;
    const res = await call('DELETE', CAT, { retailerId: 'amazon', sku: 'B0D2JGYX3F' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.evicted, false);
    assert.deepStrictEqual(deletedCalls, ['amazon/B0D2JGYX3F']);
  });
});

describe('it cannot be pointed at anything else', () => {
  const refused = async (params) => {
    const res = await call('DELETE', '/catalogue/amazon/B0D2JGYX3F', params);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(deletedCalls, [], 'nothing may be deleted on a rejected request');
  };

  test('a sku containing path traversal is refused', async () => {
    await refused({ retailerId: 'amazon', sku: '../../etc/passwd' });
  });

  test('a malformed retailer id is refused', async () => {
    await refused({ retailerId: 'BAD..ID', sku: 'B0D2JGYX3F' });
  });

  test('an over-long sku is refused', async () => {
    await refused({ retailerId: 'amazon', sku: 'A'.repeat(80) });
  });

  test('a wildcard cannot widen the blast radius', async () => {
    await refused({ retailerId: 'amazon', sku: '*' });
  });

  test('an empty sku is refused', async () => {
    await refused({ retailerId: 'amazon', sku: '' });
  });
});
