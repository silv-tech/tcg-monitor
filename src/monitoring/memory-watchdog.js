const fs = require('fs');
const logger = require('./logger');

/**
 * Restart the process gracefully BEFORE the container kills it for memory.
 *
 * MEASURED 2026-09-18 from Railway's own metrics: the main service's memory climbs in a straight
 * line (~1.4 GB/h, ~2.3 MB every 6s poll) from ~1.35 GB to ~7.7 GB of an 8 GB limit, then the
 * container is SIGKILLed — roughly every 5 hours. A SIGKILL cannot be caught, so the graceful
 * shutdown in index.js never runs, and it is that shutdown which drains the delivery queue. Every
 * kill therefore silently loses whatever alerts were queued at that moment.
 *
 * It also spends Railway's restart budget. The service runs `ON_FAILURE` with 10 retries: the
 * 6f86b26 deployment (2026-09-13 23:28) lived exactly 55h01m — its first start plus 10 restarts at
 * ~5h each — and on the eleventh kill Railway stopped restarting it. That is the 2026-09-16 06:29
 * outage: no crash, no error, just a spent budget, dark for ~10h until the next deploy.
 *
 * This does NOT fix the growth, which is outside the JS heap (0 "heap out of memory" in 48h while
 * RSS passes 7.7 GB; see MALLOC_ARENA_MAX in the Dockerfile for the attempt at the cause). It turns
 * an uncatchable kill into a graceful restart, so the queue drains first. It is the safety net that
 * holds whether or not the cause is ever found.
 *
 * Exits NON-ZERO on purpose (RESTART_EXIT_CODE). Under `ON_FAILURE` a clean exit(0) is treated as
 * "finished" and is NOT restarted, so the obvious implementation — reuse shutdown() as-is — would
 * have switched the bot off permanently the first time it fired.
 */

// 75 = EX_TEMPFAIL, "temporary failure, try again" — distinct from 1 (uncaught exception) so the
// deploy log says which one happened.
const RESTART_EXIT_CODE = 75;
const CHECK_MS = 60 * 1000;
// 80% of the container limit. At the measured ~1.4 GB/h that leaves ~1.6 GB, ~70 minutes, of
// headroom — far more than the ~10s the queue drain needs, and enough that RSS and the container's
// own accounting can disagree by a few hundred MB without the kill arriving first.
const RESTART_SHARE = 0.8;
const FALLBACK_LIMIT_MB = 8192; // the service's measured limit, used only when cgroups are unreadable

/**
 * The container's real memory limit, from cgroups (v2, then v1). Read rather than hard-coded so a
 * plan change cannot silently leave the threshold ABOVE the limit — a safety net that never fires
 * fails in exactly the silent way this exists to prevent. null when unlimited or unreadable.
 */
function readContainerLimitMb() {
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const bytes = Number(fs.readFileSync(file, 'utf8').trim());
      // "max" (v2) parses to NaN; an unlimited v1 limit is ~2^63. Both mean "no limit".
      if (Number.isFinite(bytes) && bytes > 0 && bytes < 2 ** 50) return Math.floor(bytes / 1048576);
    } catch { /* not this cgroup version, or not Linux */ }
  }
  return null;
}

function restartThresholdMb(env = process.env, limitMb = readContainerLimitMb()) {
  const override = Number(env.MEMORY_RESTART_MB);
  if (override > 0) return override;
  return Math.floor((limitMb || FALLBACK_LIMIT_MB) * RESTART_SHARE);
}

/**
 * Check RSS every minute; the first time it crosses the threshold, call onLimit once.
 * The timer is unref'd so it can never keep a process alive on its own.
 */
function startMemoryWatchdog(onLimit, opts = {}) {
  const thresholdMb = opts.thresholdMb || restartThresholdMb();
  const readRssMb = opts.readRssMb || (() => process.memoryUsage.rss() / 1048576);
  let fired = false;
  logger.info(`Memory watchdog: will restart gracefully at ${thresholdMb}MB RSS`);

  const timer = setInterval(() => {
    if (fired) return;
    const rssMb = readRssMb();
    if (rssMb < thresholdMb) return;
    fired = true;
    logger.error(`MEMORY WATCHDOG: rss ${Math.round(rssMb)}MB >= ${thresholdMb}MB — restarting `
      + `gracefully (exit ${RESTART_EXIT_CODE}) so the alert queue drains before the container `
      + `would have SIGKILLed it`);
    onLimit(Math.round(rssMb), thresholdMb);
  }, opts.intervalMs || CHECK_MS);
  timer.unref();
  return timer;
}

module.exports = { startMemoryWatchdog, restartThresholdMb, readContainerLimitMb, RESTART_EXIT_CODE };
