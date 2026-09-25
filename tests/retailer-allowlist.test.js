/**
 * RETAILERS_ONLY — the boot-time gate that lets a SECOND deployment of this repo run narrow.
 *
 * It exists so an Amazon-only service can exercise the browser bridge (amazon-extension/) without
 * forking the code or editing retailers.json. Editing the file is the obvious move and is the
 * trap: the edit would live on a branch, and merging that branch would silently disable those
 * retailers in production.
 *
 * Three properties matter, and each one is the difference between a narrow deployment and a
 * deployment that looks fine while monitoring nothing:
 *
 *   IT IS APPLIED AFTER THE REDIS OVERRIDE MERGE, so a stale `enabled:true` override in a shared
 *   Redis cannot switch a retailer back on in a service meant to be narrow.
 *
 *   AN UNKNOWN ID IS FATAL. Ignoring a typo would disable every retailer and leave a process that
 *   boots cleanly, logs nothing unusual and watches nothing — failure disguised as success.
 *
 *   AN UNSET VARIABLE CHANGES NOTHING AT ALL. This ships on the same master that runs production;
 *   if an empty value altered the config in any way, that would be a production change.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { applyRetailerAllowlist } = require('../src/core/retailer-allowlist');

const rows = () => ([
  { id: 'amazon', enabled: true, intervalMs: 6000 },
  { id: 'ebgames', enabled: true, intervalMs: 5000 },
  { id: 'walmart', enabled: true, intervalMs: 8000 },
  { id: 'pokemoncenter', enabled: false, intervalMs: 9000 },
]);
const enabledIds = (out) => out.filter(r => r.enabled).map(r => r.id);

describe('applyRetailerAllowlist', () => {
  test('unset changes nothing — production must be untouched by this shipping', () => {
    const input = rows();
    for (const raw of [undefined, '', '   ', null]) {
      const out = applyRetailerAllowlist(input, raw);
      assert.strictEqual(out, input, 'the very same array, not a copy');
    }
  });

  test('a single id runs that retailer and forces every other one off', () => {
    const out = applyRetailerAllowlist(rows(), 'amazon');
    assert.deepStrictEqual(enabledIds(out), ['amazon']);
    assert.strictEqual(out.length, 4, 'rows are kept, not removed — only disabled');
  });

  test('a comma list runs exactly those, whitespace and case forgiven', () => {
    const out = applyRetailerAllowlist(rows(), ' Amazon , EBGAMES ');
    assert.deepStrictEqual(enabledIds(out).sort(), ['amazon', 'ebgames']);
  });

  test('it does NOT enable a retailer that config had switched off', () => {
    // The allowlist narrows; it never widens. Naming pokemoncenter must not turn on an adapter
    // whose config says off — that decision belongs to the config, not to this variable.
    const out = applyRetailerAllowlist(rows(), 'pokemoncenter');
    assert.deepStrictEqual(enabledIds(out), [], 'listed but config-disabled stays disabled');
  });

  test('it overrides a Redis-merged enabled:true — the rows arrive already merged', () => {
    const merged = [
      { id: 'amazon', enabled: true },
      { id: 'ebgames', enabled: true },   // as if a stale Redis override had re-enabled it
    ];
    assert.deepStrictEqual(enabledIds(applyRetailerAllowlist(merged, 'amazon')), ['amazon']);
  });

  test('an unknown id THROWS, and names what is valid', () => {
    assert.throws(
      () => applyRetailerAllowlist(rows(), 'amazn'),
      (err) => {
        assert.match(err.message, /unknown retailer\(s\): amazn/);
        assert.match(err.message, /amazon/, 'the error must list the valid ids');
        return true;
      },
    );
  });

  test('one bad id in an otherwise good list still throws', () => {
    // Partially applying it would run a narrower set than asked for, silently.
    assert.throws(() => applyRetailerAllowlist(rows(), 'amazon,ebgamez'), /ebgamez/);
  });

  test('a list of only separators is treated as unset, not as "nothing enabled"', () => {
    const input = rows();
    assert.strictEqual(applyRetailerAllowlist(input, ',,  ,'), input);
  });

  test('the input array is not mutated', () => {
    const input = rows();
    applyRetailerAllowlist(input, 'amazon');
    assert.deepStrictEqual(enabledIds(input), ['amazon', 'ebgames', 'walmart'],
      'callers still holding the original must see it unchanged');
  });
});
