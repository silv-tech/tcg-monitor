/**
 * The memory watchdog — the safety net that turns an uncatchable container OOM kill into a
 * graceful restart that drains the alert queue first.
 *
 * MEASURED 2026-09-18: memory climbs ~1.4 GB/h to ~7.7 GB of 8 GB and the container is SIGKILLed
 * every ~5h. A SIGKILL skips index.js's shutdown(), so queued alerts are lost at every kill. And the
 * service runs Railway's ON_FAILURE policy with 10 retries: the 6f86b26 deployment lived exactly
 * 55h01m (first start + 10 restarts at ~5h), then Railway stopped restarting it — the 2026-09-16
 * 06:29 outage.
 *
 * The property that matters most is the EXIT CODE. Under ON_FAILURE a clean exit(0) is treated as
 * "finished" and is not restarted, so a watchdog that exits 0 would switch the bot off for good the
 * first time it fired — strictly worse than the OOM it replaces.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  startMemoryWatchdog, restartThresholdMb, RESTART_EXIT_CODE,
} = require('../src/monitoring/memory-watchdog');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the restart exit code', () => {
  test('is NON-ZERO — Railway ON_FAILURE does not restart a clean exit', () => {
    assert.notStrictEqual(RESTART_EXIT_CODE, 0);
    assert.notStrictEqual(RESTART_EXIT_CODE, 1, 'distinct from an uncaught exception, for the deploy log');
  });

  test('index.js actually passes it through, and shutdown exits with it', () => {
    // Guards the regression that matters: shutdown() used to end in a hard-coded exit(0). If the
    // exitCode plumbing is ever dropped, the watchdog silently becomes an off-switch.
    const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    assert.match(src, /async function shutdown\(signal, exitCode = 0\)/);
    assert.match(src, /process\.exit\(exitCode\)/);
    assert.doesNotMatch(src, /Shutdown complete'\);\s*process\.exit\(0\)/, 'no hard-coded exit(0) after the drain');
    // `.*` not `[^)]*`: the reason string carries its own parentheses — "(rss …MB >= …MB)".
    assert.match(src, /shutdown\(.*,\s*RESTART_EXIT_CODE\)/, 'the watchdog must pass the non-zero code');
  });

  test('shutdown cannot run twice — a SIGTERM mid-drain must not re-enter', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
    assert.match(src, /if \(shuttingDown\) return;\s*shuttingDown = true;/);
  });
});

describe('the threshold', () => {
  test('is 80% of the container limit when cgroups report one', () => {
    assert.strictEqual(restartThresholdMb({}, 8192), 6553);
    assert.strictEqual(restartThresholdMb({}, 4096), 3276, 'follows a smaller plan, never sits above it');
  });

  test('falls back to 80% of the measured 8 GB when the limit is unreadable', () => {
    assert.strictEqual(restartThresholdMb({}, null), 6553);
  });

  test('MEMORY_RESTART_MB overrides it', () => {
    assert.strictEqual(restartThresholdMb({ MEMORY_RESTART_MB: '5000' }, 8192), 5000);
  });

  test('a junk override is ignored rather than disabling the net', () => {
    assert.strictEqual(restartThresholdMb({ MEMORY_RESTART_MB: 'lots' }, 8192), 6553);
    assert.strictEqual(restartThresholdMb({ MEMORY_RESTART_MB: '0' }, 8192), 6553);
  });
});

describe('firing', () => {
  test('does NOT fire while memory is under the threshold', async () => {
    let fired = 0;
    const t = startMemoryWatchdog(() => { fired++; }, { thresholdMb: 1000, readRssMb: () => 999, intervalMs: 5 });
    await wait(40);
    clearInterval(t);
    assert.strictEqual(fired, 0);
  });

  test('fires when memory crosses the threshold, with the numbers', async () => {
    const calls = [];
    const t = startMemoryWatchdog((rss, limit) => calls.push([rss, limit]),
      { thresholdMb: 1000, readRssMb: () => 1234.4, intervalMs: 5 });
    await wait(40);
    clearInterval(t);
    assert.deepStrictEqual(calls[0], [1234, 1000]);
  });

  test('fires exactly ONCE, however long memory stays high', async () => {
    // A second call would start a second shutdown on top of the first.
    let fired = 0;
    const t = startMemoryWatchdog(() => { fired++; }, { thresholdMb: 1000, readRssMb: () => 5000, intervalMs: 5 });
    await wait(60);
    clearInterval(t);
    assert.strictEqual(fired, 1);
  });

  test('its timer never keeps a process alive on its own', () => {
    const t = startMemoryWatchdog(() => {}, { thresholdMb: 1000, readRssMb: () => 0, intervalMs: 1000 });
    assert.strictEqual(t.hasRef(), false);
    clearInterval(t);
  });
});

describe('the attempted fix ships with it', () => {
  test('the Dockerfile caps glibc malloc arenas', () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
    assert.match(dockerfile, /^ENV MALLOC_ARENA_MAX=2$/m);
  });
});
