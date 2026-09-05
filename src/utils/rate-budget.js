/**
 * Global outbound rate budget.
 *
 * Every rate-limit failure in this system has had the same shape: each store's own cadence
 * looked reasonable, and the SUM did not. 31 Shopify shops at 8s is 0.125 req/sec per store —
 * trivial — and ~4 req/sec in aggregate, with 7 req/sec peaks when catalogue sweeps land.
 * Shopify rate-limits the caller, so the aggregate is the only number that ever mattered, and
 * nothing in the system was watching it.
 *
 * Per-store limits cannot express that. A store tuned in isolation will always walk toward
 * its own floor, which is exactly how autotune once sped 31 shops up until they starved the
 * big six. This is the missing piece: one budget for a whole group of destinations, enforced
 * where the requests actually leave.
 *
 * A token bucket rather than a fixed delay, so a quiet period earns a little burst capacity
 * and a busy one is smoothly paced instead of stalled.
 *
 * Waiters are served by priority, then FIFO within a priority. A fixed budget is not enough on
 * its own: a catalogue sweep is ten requests back to back, which drains the bucket for ~4
 * seconds, and under a plain FIFO queue that made every latency-critical poll wait behind it
 * even though total demand was inside the budget. Sweeps are background work and can yield.
 */

const logger = require('../monitoring/logger');

const buckets = new Map();

class TokenBucket {
  constructor(name, ratePerSec, burst) {
    this.name = name;
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = Date.now();
    this.queue = [];
    this.seq = 0;
    this.granted = 0;
    this.waited = 0;
  }

  _refill(now) {
    const elapsed = (now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    this.last = now;
  }

  /**
   * Wait until a token is available.
   * @param {number} maxWaitMs give up after this long, so a poll can never hang
   * @param {number} priority lower runs first; equal priorities stay FIFO
   * @returns {Promise<boolean>} true if a token was granted
   */
  acquire(maxWaitMs, priority = 0) {
    const now = Date.now();
    this._refill(now);

    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      this.granted += 1;
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const waiter = { resolve, priority, seq: this.seq++, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(false);
      }, maxWaitMs);
      if (waiter.timer.unref) waiter.timer.unref();

      // Insert by priority, then arrival. A catalogue sweep is ten requests back to back; at
      // 2.5 req/sec that drains the bucket for ~4 seconds, and a plain FIFO queue made every
      // latency-critical poll wait behind it. Measured: shop polls sat at a 2.4-3.1s median
      // wait even though total demand (2.28 req/sec) was inside the budget. Sweeps are
      // background work and can yield; a new-listing check cannot.
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1].priority > priority) i--;
      this.queue.splice(i, 0, waiter);
      this.waited += 1;
      this._schedule();
    });
  }

  _schedule() {
    if (this._timer || this.queue.length === 0) return;
    const need = Math.max(0, 1 - this.tokens);
    const waitMs = Math.max(5, Math.ceil((need / this.ratePerSec) * 1000));
    this._timer = setTimeout(() => {
      this._timer = null;
      this._drain();
    }, waitMs);
    if (this._timer.unref) this._timer.unref();
  }

  _drain() {
    this._refill(Date.now());
    while (this.tokens >= 1 && this.queue.length > 0) {
      const waiter = this.queue.shift();
      clearTimeout(waiter.timer);
      this.tokens -= 1;
      this.granted += 1;
      waiter.resolve(true);
    }
    this._schedule();
  }

  stats() {
    return {
      name: this.name,
      ratePerSec: this.ratePerSec,
      tokens: Math.round(this.tokens * 100) / 100,
      queued: this.queue.length,
      granted: this.granted,
      waited: this.waited,
    };
  }
}

function configure(name, ratePerSec, burst) {
  const bucket = new TokenBucket(name, ratePerSec, burst);
  buckets.set(name, bucket);
  logger.info(`Rate budget "${name}": ${ratePerSec} req/sec, burst ${burst}`);
  return bucket;
}

function get(name) {
  return buckets.get(name) || null;
}

/**
 * Acquire from a named budget. Unknown budget = no limit, so callers stay simple.
 * Lower priority runs first: latency-critical work should pass 0, background work 1.
 */
async function acquire(name, maxWaitMs = 10000, priority = 0) {
  const bucket = buckets.get(name);
  if (!bucket) return true;
  return bucket.acquire(maxWaitMs, priority);
}

function stats() {
  return [...buckets.values()].map((b) => b.stats());
}

function _reset() {
  for (const b of buckets.values()) {
    if (b._timer) clearTimeout(b._timer);
    for (const w of b.queue) clearTimeout(w.timer);
  }
  buckets.clear();
}

module.exports = { configure, get, acquire, stats, _reset, TokenBucket };
