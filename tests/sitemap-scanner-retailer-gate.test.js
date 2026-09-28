/**
 * "Disabled" has to mean disabled everywhere — including the lane that bypasses the scheduler.
 *
 * Early SKU detection is driven by its own timer in index.js, not by the scheduler, so for its
 * whole life it ignored the retailer config: neither `enabled:false` in retailers.json nor
 * RETAILERS_ONLY reached it.
 *
 * Measured live on 2026-09-28, minutes after production was brought back up for Amazon alone:
 *
 *     Effective config: 1/19 retailers enabled — amazon@6s
 *     Early SKU alert sent: Sean Wotherspoon Pokemon Center Charizard Plush
 *     Early SKU alert sent: Ditto As Zorua Plush 7 In
 *     Early SKU alert sent: Ditto As Spiritomb Plush Key Chain          (+7 more)
 *
 * A deployment the operator had deliberately narrowed to one store was publishing another
 * store's plush toys into the client's paid channel. The scheduler was innocent — it really was
 * running 1/19 — which is exactly what made it hard to spot.
 *
 * The default stays "run everything" so no existing caller changes behaviour; only an explicit
 * set narrows it.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');

const SCANNER = require.resolve('../src/core/sitemap-scanner');

/**
 * Load the scanner with its two per-retailer scans replaced by recorders.
 *
 * They are module-internal, so they cannot be stubbed from outside — the module is re-required
 * with `state` and the network layer neutered, and the calls are observed through what the
 * recorders push. Anything that reaches the network would throw and fail the test loudly.
 */
function loadScanner() {
  delete require.cache[SCANNER];
  const calls = [];

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === SCANNER) {
      if (request === '../monitoring/logger') {
        return { info() {}, warn() {}, error() {}, debug() {} };
      }
      if (request === './state') {
        // Every sitemap lane funnels through diffUrls; returning no new URLs is what makes each
        // lane a no-op that still PROVES it ran.
        return {
          diffUrls: async (retailer) => { calls.push(retailer); return []; },
          getRedis: async () => null,
        };
      }
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const mod = require(SCANNER);
    return { mod, calls };
  } finally {
    Module._load = origLoad;
  }
}

describe('Early SKU retailer gate', () => {
  let scanner;

  beforeEach(() => { scanner = loadScanner(); });
  afterEach(() => { delete require.cache[SCANNER]; });

  test('scanSitemaps takes the enabled-retailer set, defaulting to null', () => {
    // Asserted on the source rather than Function.length, which is 0 for a defaulted parameter.
    // The DEFAULT is the compatibility guarantee: null must keep meaning "run everything".
    const src = fs.readFileSync(SCANNER, 'utf8');
    assert.match(src, /async function scanSitemaps\(enabledRetailerIds = null\)/);
  });

  test('an empty set runs NOTHING and returns no events', async () => {
    // The production shape of the bug: amazon-only, so neither lane may run.
    const events = await scanner.mod.scanSitemaps(new Set(['amazon']));
    assert.deepStrictEqual(events, []);
  });

  test('a set without walmart or pokemoncenter is a silent no-op', async () => {
    const events = await scanner.mod.scanSitemaps(new Set());
    assert.deepStrictEqual(events, []);
  });

  test('null does NOT short-circuit — existing callers still scan', () => {
    // Deliberately not executed: calling it for real reaches the network and the live sitemaps.
    // The guard is the one line that could silently disable every caller, so pin its shape.
    const src = fs.readFileSync(SCANNER, 'utf8');
    assert.match(src, /const runs = \(id\) => !enabledRetailerIds \|\| enabledRetailerIds\.has\(id\)/,
      'null/undefined must fall through to "allowed"');
    assert.match(src, /if \(!runs\('walmart'\) && !runs\('pokemoncenter'\)\) return \[\]/,
      'the early return must require BOTH lanes to be off');
  });
});
