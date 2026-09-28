/**
 * The live trigger feed the auto-checkout extension consumes.
 *
 * WHAT THIS IS. When an Amazon restock alert is dispatched, a trigger is published here. The
 * extension holds a long-poll open against /api/checkout/next and receives it within
 * milliseconds, then decides locally whether to buy. This is the latency path: every millisecond
 * here is a millisecond of a drop we lose, so it is deliberately the simplest thing that can work
 * — an in-memory ring buffer and a set of parked HTTP responses.
 *
 * WHY LONG-POLL RATHER THAN A WEBSOCKET. The competitor product (PokeACO) uses a WebSocket, and
 * copying that would have cost a new server dependency (`ws` is not in package.json) and would
 * not survive an MV3 service worker, which has no EventSource and is evicted after ~30s idle. A
 * long-poll is one ordinary `fetch` that keeps the worker alive for as long as it is in flight.
 *
 * WHY A CURSOR. Their design broadcasts and the client dedupes on a message id, so a trigger
 * fired while a client is reconnecting is simply gone. That is the exact moment a drop happens —
 * reconnects cluster when the server is busy. Every trigger here gets a monotonic sequence
 * number, and a client asks for "everything after N". A reconnect inside the buffer window
 * misses nothing.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not know what any subscriber wants to buy. It
 * broadcasts what restocked; the extension filters against a list that never leaves the user's
 * machine. That keeps subscriber watchlists — and the fact that someone is buying at all — off
 * this server entirely.
 */

const logger = require('../monitoring/logger');

// How many recent triggers to retain. A reconnect only needs to cover the gap, and a drop wave is
// bursty, so this is sized for "a client was away for a few seconds", not for history.
const BUFFER_SIZE = Number(process.env.CHECKOUT_FEED_BUFFER) || 200;

// A trigger older than this is not worth acting on: the offer that fired it is long gone, and
// buying into a stale signal is how an auto-buyer surprises someone an hour later. The extension
// enforces this too; belt and braces, because only one of the two is ours to update quickly.
const MAX_AGE_MS = Number(process.env.CHECKOUT_FEED_MAX_AGE_MS) || 120000;

class CheckoutFeed {
  constructor() {
    this._seq = 0;
    this._buffer = [];      // [{ seq, at, trigger }]
    this._waiters = new Set(); // parked long-polls: { since, resolve, timer }
    this._published = 0;
  }

  /**
   * Publish a restock trigger.
   *
   * MUST NEVER THROW. Its only caller is on the delivery path, where an exception skips
   * markSent() and the alert then retries for ever — a failure mode this repo has already paid
   * for once. Everything here is wrapped.
   *
   * @returns {number|null} the sequence number, or null if it was refused
   */
  publish(trigger) {
    try {
      if (!trigger || typeof trigger !== 'object') return null;
      const asin = typeof trigger.asin === 'string' ? trigger.asin.trim() : '';
      if (!asin) return null;

      const entry = {
        seq: ++this._seq,
        at: Date.now(),
        trigger: {
          asin,
          // The offer the alert actually fired on. Without it the extension would buy whatever
          // is in the buy box when it arrives, which is the same bug the ATC links had.
          offerId: trigger.offerId || null,
          price: Number.isFinite(trigger.price) ? trigger.price : null,
          title: typeof trigger.title === 'string' ? trigger.title.slice(0, 200) : null,
          seller: trigger.seller || null,
          // Whether the seller gate actually confirmed Amazon, as opposed to failing open. The
          // extension needs to be able to refuse to buy on an unverified seller even when the
          // ALERT was allowed to send — those are different risk decisions and only one of them
          // spends someone's money.
          sellerVerified: trigger.sellerVerified === true,
          url: trigger.url || `https://www.amazon.ca/dp/${asin}`,
        },
      };

      this._buffer.push(entry);
      if (this._buffer.length > BUFFER_SIZE) this._buffer.splice(0, this._buffer.length - BUFFER_SIZE);
      this._published++;

      this._wake();
      return entry.seq;
    } catch (err) {
      logger.warn(`checkout-feed: publish failed: ${err.message}`);
      return null;
    }
  }

  /** Everything after `since` that is still fresh enough to act on. */
  _since(since) {
    const cutoff = Date.now() - MAX_AGE_MS;
    return this._buffer
      .filter(e => e.seq > since && e.at >= cutoff)
      .map(e => ({ seq: e.seq, at: e.at, ...e.trigger }));
  }

  _wake() {
    for (const w of [...this._waiters]) {
      const items = this._since(w.since);
      if (items.length === 0) continue;
      this._waiters.delete(w);
      clearTimeout(w.timer);
      try { w.resolve({ cursor: this._seq, items }); } catch { /* response already gone */ }
    }
  }

  /**
   * Park until something newer than `since` exists, or `waitMs` elapses.
   *
   * Returns immediately when the client is already behind — that is the reconnect case, and
   * making it wait would add the very latency this whole file exists to remove.
   */
  wait(since = 0, waitMs = 25000) {
    const from = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
    const ready = this._since(from);
    if (ready.length > 0) return Promise.resolve({ cursor: this._seq, items: ready });

    const ms = Math.max(1000, Math.min(60000, Number(waitMs) || 25000));
    return new Promise((resolve) => {
      const w = { since: from, resolve, timer: null };
      // An empty answer on timeout is normal and is how the client learns the cursor advanced
      // past entries that aged out. It must never look like an error.
      w.timer = setTimeout(() => {
        this._waiters.delete(w);
        resolve({ cursor: this._seq, items: [] });
      }, ms);
      this._waiters.add(w);
    });
  }

  stats() {
    return {
      cursor: this._seq,
      buffered: this._buffer.length,
      waiting: this._waiters.size,
      published: this._published,
    };
  }

  /** Release every parked request. Called on shutdown so the process can exit promptly. */
  close() {
    for (const w of [...this._waiters]) {
      clearTimeout(w.timer);
      this._waiters.delete(w);
      try { w.resolve({ cursor: this._seq, items: [] }); } catch { /* ignore */ }
    }
  }

  /** Tests only. */
  _reset() {
    this.close();
    this._seq = 0;
    this._buffer = [];
    this._published = 0;
  }
}

module.exports = new CheckoutFeed();
module.exports.CheckoutFeed = CheckoutFeed;
