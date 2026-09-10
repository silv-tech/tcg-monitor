const BaseAdapter = require('./base');
const logger = require('../monitoring/logger');
const state = require('../core/state');
const { sleep, hashSku } = require('../utils/helpers');
const scraperApi = require('../utils/scraper-api');
const { curlGet } = require('../utils/curl-get');
const { isInScopeName } = require('../utils/scope');

const DEEP_CRAWL_INTERVAL_DEFAULT = 5 * 60 * 1000;
const DEEP_CRAWL_INTERVAL_FLOOR = 60 * 1000;
const CONCURRENCY = 4;

// A single crawl may never delete more than this share of the known catalogue. EB Games has
// ~250 tracked products; a real delisting trickles, a bad read arrives all at once.
const MAX_DROP_SHARE = 0.2;

// Odoo eCommerce category routes — only the games the client tracks.
// fastPages: pages fetched every poll (newest-first + recently-modified); the deep crawl covers the rest.
const SOURCES = [
  { key: 'pokemon',  path: '/shop/category/trading-cards-pokemon-204', fastPages: 2 },
  { key: 'onepiece', path: '/shop/category/trading-cards-one-piece-208', fastPages: 1 },
];

// How long after the last browser push EB Games still counts as fresh. Sized well above the
// extension's refresh interval so one slow reload does not flap the retailer's health.
const PUSH_STALE_MS = Number(process.env.EBGAMES_PUSH_STALE_MS) || 3 * 60 * 1000;

// How long the silent seed lasts after the first push of a process. The extension now sweeps the
// WHOLE category (every page, ~250 products) rather than only page 1, so pages 2..N arrive as
// separate pushes over one sweep (~9 min). Flipping "seeded" after the first push — as the
// original single-page bridge did — would let every later page fire NEW_SKU/RESTOCK at once, a
// storm into the client's channel the moment coverage widens. Instead the seed spans a window
// that comfortably exceeds one full sweep: every push inside it silently writes Redis-missing
// SKUs (deploy purges Redis first, so the window re-baselines the current stock of the whole
// catalogue), and only after it do real stock/price deltas alert. Env-tunable.
const SEED_WINDOW_MS = Number(process.env.EBGAMES_SEED_WINDOW_MS) || 15 * 60 * 1000;

// How many PUSHES must land before a still-unconfirmed hydrated row is treated as delisted.
// Both tabs push once per ~25s cycle and a full sweep is ~21 cycles, so one sweep is ~42
// pushes; this is roughly three sweeps of margin. Counted in pushes rather than elapsed time on
// purpose — see _evictUnconfirmed, where the clock-based version was a flood waiting to happen.
const HYDRATE_GRACE_PUSHES = Number(process.env.EBGAMES_HYDRATE_GRACE_PUSHES) || 150;

// How long to wait before retrying a hydrate that failed. Long enough that the retry cannot put
// a 5s Redis timeout on every 5s poll, short enough that a brief Redis outage at boot does not
// leave the adapter cold for the life of the process.
const HYDRATE_RETRY_MS = Number(process.env.EBGAMES_HYDRATE_RETRY_MS) || 30 * 1000;

const SORT_NEWEST = 'create_date desc';
const SORT_MODIFIED = 'write_date desc';

// Cloudflare challenges impit here unless cert verification is off (it changes the TLS ClientHello)
const STEALTH_OPTS = { ignoreTlsErrors: true, timeoutMs: 12000 };

// Paid fallback pacing.
//
// Cloudflare began refusing every free route into ebgames.ca — direct, ISP and residential all
// answer 403 in under 200ms — and the adapter reported "found 0 products" on every poll while
// looking healthy, because a poll that returns nothing without throwing is not an error.
// Measured 2026-09-08: ScraperAPI standard returns the real listing (927KB, 27 product links,
// no challenge) for 1 credit, so the store is recoverable, just not for free.
//
// The floor is on the PAID path only. The free path keeps trying at the adapter's own interval,
// so the moment Cloudflare relents EB Games returns to full speed at zero cost with no
// intervention. A burst window lets one poll's pages through together — gating per request
// would starve pages 2 and 3 of every cycle — while still allowing only one burst per floor.
const PAID_FLOOR_MS = Number(process.env.EBGAMES_PAID_FLOOR_MS) || 30000;
const PAID_BURST_MS = Number(process.env.EBGAMES_PAID_BURST_MS) || 15000;
// A time window alone does not bound cost. Measured after shipping the floor: 56,640 credits a
// day, 4.4x the estimate, because the 5-minute deep crawl's ~30 pages all rode through a single
// open window — the floor limited how OFTEN a burst starts, never how much went through one.
// Capping calls per burst is what actually bounds the spend; the deep crawl simply completes
// across several bursts instead of one, which costs it nothing that matters.
const PAID_MAX_PER_BURST = Number(process.env.EBGAMES_PAID_MAX_PER_BURST) || 4;
// The deep crawl needs a whole catalogue in one pass, so a four-call burst starves it: capping
// it there pinned coverage at 67 of 801 products, because every crawl re-fetched the same first
// four pages and never reached the rest. It gets its own grant per crawl instead — bounded, so
// it still cannot run away, but large enough to finish. Cost is this number times the number of
// crawls per day, which is what deepCrawlIntervalMs controls.
const PAID_MAX_PER_CRAWL = Number(process.env.EBGAMES_PAID_MAX_PER_CRAWL) || 40;

// How long to stop trying curl after it is refused.
//
// curl is the only client this Cloudflare accepts — from a residential address. From Railway's
// datacenter address it answers 403 no matter the client, which only became visible once the
// container had a CA bundle; before that curl failed at TLS and looked like a different problem
// entirely. So the free route is real, just not available from here. It is still attempted, only
// rarely: datacenter ranges do get unblocked, and the day this one is, EB Games goes free again
// with nobody watching for it.
const CURL_RETRY_AFTER_MS = Number(process.env.EBGAMES_CURL_RETRY_MS) || 30 * 60 * 1000;

// Cloudflare rate-limits bursts (~90 requests in 7s got 429s, 2 req/s still tripped it occasionally)
const MIN_SPACING_DEFAULT = 750;
const MIN_SPACING_FLOOR = 400;
const RATE_LIMIT_COOLDOWN_MS = 15000;

const CARD_RE = /<form role="article"[^>]*\boe_product_cart\b[^>]*>[\s\S]*?<\/form>/g;

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function isChallenge(html) {
  return !html || html.length < 2000
    || /<title>Just a moment/i.test(html) || html.includes('_cf_chl_opt') || html.includes('cf-browser-verification');
}

function maxPage(html) {
  let max = 1;
  for (const m of html.matchAll(/\/page\/(\d+)/g)) max = Math.max(max, parseInt(m[1], 10));
  return max;
}

function parseCard(card, baseUrl, game) {
  const link = card.match(/href="\/shop\/(?:[^"/]+\/)?(\d+)-([^"]*?)-(\d+)"/);
  if (!link) return null;
  const [, sku, slug, templateId] = link;

  const label = card.match(/aria-label="([^"]*)"/);
  const name = label ? decodeEntities(label[1]).replace(/\s+/g, ' ').trim() : '';
  if (!name) return null;

  const priceMatch = card.match(/condition_prices\[&#39;new&#39;\][^>]*>[^<]*<span class="oe_currency_value">([\d.,]+)/)
    || card.match(/oe_currency_value">([\d.,]+)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

  const badges = [...card.matchAll(/class="s_badge[^"]*"[^>]*>(?:\s*<i[^>]*><\/i>)?\s*([^<]+)</g)].map(m => m[1].trim());
  const badgeInStock = badges.some(b => /in stock/i.test(b));
  const canAddToCart = /name="product_id"/.test(card);
  const productId = card.match(/name="product_id"[^>]*value="(\d+)"/);
  const img = card.match(/<img src="([^"]+)"/);

  return {
    sku,
    name,
    price,
    currency: 'CAD',
    url: `${baseUrl}/shop/${sku}-${slug}-${templateId}`,
    image: img ? `${baseUrl}${decodeEntities(img[1])}` : '',
    inStock: badgeInStock || canAddToCart,
    canAddToCart,
    isPreorderable: /pre-?order/i.test(name),
    seller: 'EB Games',
    shipsToHome: true,
    templateId,
    _productId: productId ? productId[1] : null,
    game,
  };
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await tasks[i]() };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

class EBGamesAdapter extends BaseAdapter {
  constructor(config) {
    super(config);
    this.watchlist = new Set(config.watchlist || []);
    this._knownProducts = new Map(); // sku → classified product (full catalog from deep crawl)
    this._pageCounts = new Map();    // source key → page count from last deep crawl
    this._lastDeepCrawlAt = 0;
    this._deepCrawlRunning = false;
    this._nextSlot = 0;
    this._cooldownUntil = 0;
    this._lastPaidAt = 0;
    this._paidWindowUntil = 0;
    this._paidFetches = 0;
    this._paidInBurst = 0;
    this._crawlPaidRemaining = 0;
    this._seedStartedAt = 0;   // when the silent-seed window opened (first push of this process)
    this._curlReported = false;
    this._curlBlockedUntil = 0;
    this._seeded = false;
    this._hydrated = false;          // catalogue reloaded from Redis once per process
    this._hydrateRetryAt = 0;
    this._unconfirmed = new Set();   // hydrated SKUs the browser has not re-sent yet
    this._pushesSinceHydrate = 0;
    this._evictShareWarned = false;
    this._startedAt = Date.now();

    // Push mode: this adapter never reaches out to ebgames.ca. Listings arrive from the
    // companion Chrome extension (ebgames-extension/), which loads the category pages in a
    // real browser and POSTs the HTML to /api/ingest/ebgames.
    //
    // Measured 2026-09-08, all from a residential address, so IP is not the variable:
    //   node fetch (Chrome UA)          403  Cf-Mitigated: challenge
    //   curl                            403  same
    //   patchright Chromium, headless   never leaves "Just a moment"
    //   patchright Chromium, headed     same
    //   real Chrome over CDP            200 once, then 403 in 67ms (edge-cached block)
    // Cloudflare runs a managed JS challenge here and scores the CLIENT, so no amount of
    // proxying fixes it — which is what the paid route was really buying. Only a genuine
    // browser profile passes, so that is where the fetch now happens.
    //
    // ON BY DEFAULT, because the alternative is the paid route at ~14,400 credits/day. With
    // push mode on and no extension running, EB Games simply reports nothing: no alerts, no
    // spend. Set EBGAMES_PUSH_ONLY=false to restore the old fetching behaviour.
    this.pushOnly = process.env.EBGAMES_PUSH_ONLY !== 'false';
    this._lastPushAt = 0;
    this._pushes = 0;

    this._deriveTiming();
  }

  /**
   * Accept a category listing captured by a real browser.
   *
   * Runs the SAME parser the fetching path uses, so there is no second copy of the card
   * extraction to drift out of step with the site.
   *
   * @returns {{parsed:number, known:number, seeded:boolean}}
   */
  async ingestPushed(html, sourceKey) {
    const source = SOURCES.find(s => s.key === sourceKey);
    if (!source) throw new Error(`unknown source "${sourceKey}"`);
    if (typeof html !== 'string' || html.length === 0) throw new Error('empty body');
    // isChallenge already rejects anything under 2000 chars as well as the challenge markup
    // itself, so the message names both — a listing is ~900kb and neither case is one.
    if (isChallenge(html)) {
      throw new Error('body is not a listing — a Cloudflare challenge, or too short');
    }

    const fresh = new Map();
    const parsed = this._ingest(html, source, fresh);
    // A page that parses to nothing means the card markup moved, and merging it would look
    // exactly like EB Games delisting the category. Refuse it and let the caller see why.
    if (parsed === 0) throw new Error('parsed 0 products — card markup may have changed');

    this._merge(fresh, false);

    // The browser has now confirmed these SKUs first-hand, so they are no longer standing on
    // hydrated state and are exempt from the grace eviction in fetchProducts().
    if (this._unconfirmed.size > 0) for (const sku of fresh.keys()) this._unconfirmed.delete(sku);
    this._pushesSinceHydrate += 1;

    // Silent seed spans the FIRST FULL SWEEP, not just the first push. The extension sweeps
    // every page of the category, so pages 2..N land as separate pushes; seeding only the first
    // would let all the later pages alert at once. Keep seeding (Redis-missing SKUs, no alert)
    // on every push until SEED_WINDOW_MS after the first, which exceeds one sweep, then start
    // alerting on real deltas. _seedRedis flips _seeded only when passed complete===true.
    const seeding = !this._seeded;
    if (seeding) {
      if (this._seedStartedAt === 0) this._seedStartedAt = Date.now();
      const windowClosed = Date.now() - this._seedStartedAt >= SEED_WINDOW_MS;
      await this._seedRedis(windowClosed);
    }

    this._lastPushAt = Date.now();
    this._pushes += 1;
    return { parsed, known: this._knownProducts.size, seeded: seeding };
  }

  _deriveTiming() {
    this.deepCrawlIntervalMs = this.timingValue('deepCrawlIntervalMs', DEEP_CRAWL_INTERVAL_DEFAULT, DEEP_CRAWL_INTERVAL_FLOOR);
    this.minSpacingMs = this.timingValue('minSpacingMs', MIN_SPACING_DEFAULT, MIN_SPACING_FLOOR);
  }

  // Global spacer shared by every EB Games request (crawl, fast poll, watchlist)
  async _throttle() {
    const now = Date.now();
    const slot = Math.max(now, this._nextSlot, this._cooldownUntil);
    this._nextSlot = slot + this.minSpacingMs;
    if (slot > now) await sleep(slot - now);
  }

  async fetchProducts() {
    // Push mode reports what the browser last sent and reaches out to nobody. Freshness is
    // "did a push land recently", so a PC that went to sleep shows up as a stale retailer in
    // /api/health rather than as a store that quietly stopped finding anything.
    if (this.pushOnly) {
      await this._hydrateFromRedis();
      this._evictUnconfirmed();
      const age = Date.now() - this._lastPushAt;
      const live = this._lastPushAt > 0 && age <= PUSH_STALE_MS;
      this.reportFreshness(live ? 1 : 0, 1);
      // A catalogue alone is no longer evidence a push ever landed — hydration fills it at
      // boot — so the warning keys off _lastPushAt. It also has to say WHICH case it is:
      // with _lastPushAt still 0, `age` is the epoch, and this used to print
      // "no push in 1789070602s".
      //
      // The never-pushed branch waits out PUSH_STALE_MS from process start before complaining.
      // Without that, hydration makes the catalogue non-empty immediately and EVERY boot logs
      // "the extension is not running" before the extension has had its first 25s cycle —
      // ~20 false alarms a day in the one log line used to spot a genuinely dead bridge.
      const neverPushed = this._lastPushAt === 0;
      const worthSaying = neverPushed
        ? this._knownProducts.size > 0 && Date.now() - this._startedAt >= PUSH_STALE_MS
        : true;
      if (!live && worthSaying && !this._pushStaleWarned) {
        this._pushStaleWarned = true;
        const since = neverPushed ? 'since this process started' : `in ${Math.round(age / 1000)}s`;
        logger.warn(`EB Games: no push ${since} — is the Chrome extension running?`);
      }
      if (live) this._pushStaleWarned = false;
      return Object.fromEntries(this._knownProducts);
    }

    if (this._knownProducts.size === 0) {
      // First run seeds the catalog. It is backgrounded so a slow crawl can't blow the
      // scheduler's adapter timeout; the poll returns empty and the next one picks up
      // the seeded catalog. _seedRedis keeps that first landing from firing NEW_SKU.
      if (!this._deepCrawlRunning) {
        this._deepCrawl().catch(err => logger.warn(`EB Games: seed crawl error: ${err.message}`));
      }
      return {};
    } else {
      if (!this._deepCrawlRunning && Date.now() - this._lastDeepCrawlAt >= this.deepCrawlIntervalMs) {
        this._deepCrawl().catch(err => logger.warn(`EB Games: deep crawl error: ${err.message}`));
      }
      await this._fastPoll();
    }
    return Object.fromEntries(this._knownProducts);
  }

  _listingUrl(source, page, sort) {
    const params = new URLSearchParams({ order: sort });
    return `${this.url}${source.path}${page > 1 ? `/page/${page}` : ''}?${params}`;
  }

  /**
   * May this fetch use the paid route?
   *
   * Opens a short window on the first paid call so the rest of that poll's pages come with it,
   * then closes until the floor has elapsed. Without the window a 20s floor would deliver one
   * page per 20s and never assemble a complete listing.
   */
  _paidAllowed() {
    // A crawl in progress spends from its own grant first: it is refreshing the whole
    // catalogue, not racing a drop, and the fast poll's burst cap is sized for 3 pages.
    if (this._crawlPaidRemaining > 0) { this._crawlPaidRemaining -= 1; return true; }
    const now = Date.now();
    if (now < this._paidWindowUntil) {
      if (this._paidInBurst >= PAID_MAX_PER_BURST) return false;
      this._paidInBurst += 1;
      return true;
    }
    if (now - this._lastPaidAt < PAID_FLOOR_MS) return false;
    this._lastPaidAt = now;
    this._paidWindowUntil = now + PAID_BURST_MS;
    this._paidInBurst = 1;
    return true;
  }

  async _fetchListing(url) {
    await this._throttle();

    // curl first, because it is the only client Cloudflare accepts here — and it is free.
    //
    // Measured from one address within minutes: impit with a Chrome fingerprint 403,
    // node-fetch 403, undici 403, curl 200 with the full 926KB listing in ~1s. Spoofing Chrome
    // is actively worse than not spoofing anything on this host. Getting this right takes EB
    // Games off the paid route entirely, which was running at ~14,400 credits a day.
    //
    // Any failure falls through to the routes below, so this can only add coverage.
    try {
      // Backing off after a refusal. curl is the only client this Cloudflare accepts, but only
      // from a residential address — from Railway's datacenter address it answers 403 whatever
      // the client. Retrying every request would add a pointless 403 to a host already refusing
      // us; retrying rarely means the day the range is unblocked, EB Games goes free on its own.
      if (Date.now() < this._curlBlockedUntil) throw new Error('curl backing off after a refusal');
      const res = await curlGet(url, { timeoutMs: 20000 });
      if (res && res.status === 200 && !isChallenge(res.body)) {
        this._curlBlockedUntil = 0;
        // Say which strategy actually served the page, once. Whether curl works from this host
        // decides whether EB Games is free or costs ~14,400 credits a day, and without this the
        // only symptom is a credit counter moving for reasons nobody can see.
        if (!this._curlReported) {
          this._curlReported = true;
          logger.info('EB Games: curl works from this host — listings are free, no paid fallback needed');
        }
        return res.body;
      }
      this._curlBlockedUntil = Date.now() + CURL_RETRY_AFTER_MS;
      if (!this._curlReported) {
        this._curlReported = true;
        const why = !res ? 'curl binary unavailable'
          : res.status === 0 ? `transfer failed: ${res.error || 'unknown'}`
            : `HTTP ${res.status}`;
        logger.warn(`EB Games: curl did NOT work here (${why}) — falling back to the paid route, `
          + `retrying every ${Math.round(CURL_RETRY_AFTER_MS / 60000)}min in case the range is unblocked`);
      }
    } catch (err) {
      if (!this._curlReported) {
        this._curlReported = true;
        logger.warn(`EB Games: curl threw (${err.message}) — falling back to the paid route`);
      }
    }

    let stealthErr = null;
    try {
      const html = await this.stealthFetch(url, { ...STEALTH_OPTS, maxRetries: 2, retryDelayMs: 1500 });
      if (isChallenge(html)) throw new Error('Cloudflare challenge');
      return html;
    } catch (err) {
      if (err.message.includes('429')) this._cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      stealthErr = err;
    }

    // Free route refused. Pay for it, but only as often as the floor allows.
    if (!scraperApi.isConfigured()) throw stealthErr;
    if (!this._paidAllowed()) {
      // OUR choice, not the retailer's. Marked so the poll can tell the two apart: the free
      // route is blocked and we have decided not to buy this page yet.
      const skip = new Error(`Paid floor: not buying ${url} yet`);
      skip.selfSkip = true;
      throw skip;
    }
    const html = await scraperApi.scraperFetch(url, {
      render: false, premium: false, ultraPremium: false,
      retailerId: this.id, minIntervalMs: 0, timeoutMs: 45000,
    });
    // null means rate-limited or budget-paused upstream, not a page — surface the original
    // failure so health sees the free route's error rather than a silent empty result.
    if (!html || isChallenge(html)) throw stealthErr;
    this._paidFetches = (this._paidFetches || 0) + 1;
    return html;
  }

  // Runs listing jobs through the pool; whatever failed gets one more attempt after the rest finish
  async _fetchJobs(jobs) {
    const results = await runPool(jobs.map(j => () => this._fetchListing(j.url)), CONCURRENCY);
    const retryIdx = results.map((r, i) => (r.ok ? -1 : i)).filter(i => i >= 0);
    if (retryIdx.length > 0) {
      const second = await runPool(retryIdx.map(i => () => this._fetchListing(jobs[i].url)), CONCURRENCY);
      retryIdx.forEach((idx, k) => { results[idx] = second[k]; });
    }
    return results;
  }

  /** @returns {number} product cards actually parsed out of this page */
  _ingest(html, source, into) {
    let added = 0;
    let outOfScope = 0;
    for (const m of html.matchAll(CARD_RE)) {
      const parsed = parseCard(m[0], this.url, source.key);
      if (!parsed) continue;
      // The shared scope rule — the one every other retailer already applies. EB Games was
      // missed when it was centralised, so its catalogue carried accessories: page 1 of the
      // Pokemon category on 2026-09-08 held "Ultra Pro Pokémon Dragonite Pro-Binder", which
      // names the game, has a price and a stock flag, and would have alerted like any box.
      if (!isInScopeName(parsed.name)) { outOfScope++; continue; }
      added++;
      if (!into.has(parsed.sku)) into.set(parsed.sku, this.classify(parsed));
    }
    if (outOfScope > 0) {
      logger.debug(`EB Games: skipped ${outOfScope} out-of-scope card(s) on this page`);
    }
    return added;
  }

  // Newer observation wins — a background crawl must not overwrite a fresher fast-poll result
  _merge(fresh, replace) {
    const target = replace ? new Map(fresh) : this._knownProducts;
    const previous = this._knownProducts;
    for (const [sku, old] of previous) {
      const next = fresh.get(sku);
      if (!next) { if (!replace) target.set(sku, old); continue; }
      if (old.lastSeen > next.lastSeen) target.set(sku, old);
      else target.set(sku, next);
    }
    for (const [sku, next] of fresh) if (!previous.has(sku)) target.set(sku, next);
    this._knownProducts = target;
  }

  // Every poll: newest-first + recently-modified pages of the hot categories.
  // Categories small enough to fit in fastPages are covered completely each poll.
  async _fastPoll() {
    const start = Date.now();
    const jobs = [];
    for (const src of SOURCES) {
      if (!src.fastPages) continue;
      const total = this._pageCounts.get(src.key) || src.fastPages;
      if (total <= src.fastPages) {
        for (let p = 1; p <= total; p++) jobs.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
      } else {
        for (let p = 1; p <= src.fastPages; p++) {
          jobs.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
          jobs.push({ src, url: this._listingUrl(src, p, SORT_MODIFIED) });
        }
      }
    }

    const results = await this._fetchJobs(jobs);
    const seen = new Map();
    let ok = 0;
    results.forEach((r, i) => {
      if (!r.ok) {
        if (r.error && r.error.selfSkip) logger.debug(`EB Games: ${r.error.message}`);
        else logger.warn(`EB Games: fast fetch failed ${jobs[i].url}: ${r.error.message}`);
        return;
      }
      ok++;
      this._ingest(r.value, jobs[i].src, seen);
    });
    if (ok === 0) {
      // Every page refused BY US is not a retailer failure and must not count as a poll error.
      // The fast poll runs every 5s while the paid floor allows a purchase every 30s, so five
      // polls in six legitimately buy nothing. Counting those as errors gave EB Games 33
      // consecutive failures and a degraded health status while it was working correctly — and
      // enough of them would trip the circuit breaker, whose recovery probes would hit the same
      // floor. That exact loop kept the Shopify shops down for hours on 2026-09-05.
      const allSelfSkip = results.every((r) => !r.ok && r.error && r.error.selfSkip);
      if (allSelfSkip) {
        logger.debug('EB Games: fast poll skipped — paid floor not elapsed, free route blocked');
        return;
      }
      throw new Error('all fast-poll pages failed (Cloudflare block?)');
    }

    const added = [...seen.keys()].filter(sku => !this._knownProducts.has(sku)).length;
    this._merge(seen, false);
    const inStock = [...seen.values()].filter(p => p.inStock).length;
    logger.info(`EB Games: FAST — ${ok}/${jobs.length} pages, ${seen.size} products (${inStock} in stock${added ? `, ${added} new` : ''}), ${Date.now() - start}ms`);
  }

  // Every 5 min: every page of every category (page size is locked to 10 server-side).
  async _deepCrawl() {
    // Fresh grant per crawl. Set here rather than in the constructor so a crawl that dies
    // partway cannot leave credit behind for the fast poll to spend.
    this._crawlPaidRemaining = PAID_MAX_PER_CRAWL;
    this._deepCrawlRunning = true;
    const start = Date.now();
    try {
      const fresh = new Map();
      let fetched = 0;
      let failed = 0;
      // A page can return HTTP 200 and still contain no product cards — Odoo pagination
      // drifts, and a re-render can briefly omit the grid. That is NOT evidence the products
      // are gone, but it used to be treated as exactly that.
      let empty = 0;

      const firstJobs = SOURCES.map(src => ({ src, url: this._listingUrl(src, 1, SORT_NEWEST) }));
      const firstPages = await this._fetchJobs(firstJobs);
      const remaining = [];
      firstPages.forEach((r, i) => {
        const { src } = firstJobs[i];
        if (!r.ok) { failed++; logger.warn(`EB Games: ${src.key} page 1 failed: ${r.error.message}`); return; }
        fetched++;
        const pages = maxPage(r.value);
        this._pageCounts.set(src.key, pages);
        if (this._ingest(r.value, src, fresh) === 0) empty++;
        for (let p = 2; p <= pages; p++) remaining.push({ src, url: this._listingUrl(src, p, SORT_NEWEST) });
      });

      const rest = await this._fetchJobs(remaining);
      rest.forEach((r, i) => {
        if (!r.ok) { failed++; return; }
        fetched++;
        if (this._ingest(r.value, remaining[i].src, fresh) === 0) empty++;
      });

      if (fetched === 0) throw new Error('all listing pages failed (Cloudflare block?)');

      // Only a complete, plausible crawl may drop delisted products.
      //
      // "Complete" used to mean every page returned HTTP 200. That let a page which loaded
      // fine but parsed zero cards count as an authoritative "these products no longer
      // exist": they were dropped from _knownProducts, poll-adapter's stale cleanup marked
      // them out of stock, and the next crawl brought them all back at once. That is the
      // source of the bursts — the alert limiter recorded "21 alerts in 0s", one poll
      // flipping the catalogue, not products restocking every 24 minutes.
      //
      // The share guard is the second line of defence. Even a technically clean crawl that
      // wants to delete most of the catalogue is far more likely to be a bad read than a
      // retailer delisting its entire Pokemon range in five minutes.
      const knownBefore = this._knownProducts.size;
      const wouldDrop = knownBefore
        ? [...this._knownProducts.keys()].filter(sku => !fresh.has(sku)).length / knownBefore
        : 0;
      const trustworthy = failed === 0 && empty === 0 && wouldDrop <= MAX_DROP_SHARE;
      if (!trustworthy && knownBefore > 0 && (empty > 0 || wouldDrop > MAX_DROP_SHARE)) {
        logger.warn(`EB Games: not dropping products this crawl — ${empty} empty page(s), ` +
          `would have removed ${Math.round(wouldDrop * 100)}% of ${knownBefore}`);
      }
      this._merge(fresh, trustworthy);
      this._lastDeepCrawlAt = Date.now();
      if (!this._seeded) await this._seedRedis(failed === 0);

      const inStock = [...this._knownProducts.values()].filter(p => p.inStock).length;
      logger.info(`EB Games: DEEP — ${fetched} pages${failed ? ` (${failed} failed)` : ''}${empty ? ` (${empty} empty)` : ''}, ${this._knownProducts.size} products (${inStock} in stock), ${Date.now() - start}ms. Next in ${Math.round(this.deepCrawlIntervalMs / 60000)}min.`);
    } finally {
      this._deepCrawlRunning = false;
    }
  }

  /**
   * Reload the catalogue from Redis once per process.
   *
   * `_knownProducts` is in-memory only, and in push mode this adapter CANNOT rebuild it on its
   * own — it refills one category page per ~25s as the extension walks the pager, so a full
   * sweep takes 6-16 minutes. Redis meanwhile still holds the whole catalogue. Without this,
   * poll-adapter compares a nearly-empty map against a full one; its stale cleanup concludes
   * the rest were delisted and writes inStock:false across the catalogue; then every page the
   * sweep reaches fires a RESTOCK for products that never moved.
   *
   * Measured 2026-09-10 over 9h13m and 20 restarts: 436 EB Games RESTOCK alerts across just 49
   * SKUs, every SKU firing 5-19 times, 78.7% within ten minutes of a process start, repeats as
   * close as 14 seconds apart, and whole 12-card page blocks flipping together. All 628
   * stale-cleanup sweeps in that window ran within ten minutes of a restart; none ran later.
   *
   * ccba1cf fixed exactly this for Amazon and recorded that "Shopify and EB Games already did
   * this". Shopify does (_loadHandleIndex); EB Games never did, so it was skipped.
   *
   * This does NOT make a dead extension look alive. Freshness is still `_lastPushAt`, so a
   * browser that stopped pushing reports 0/1 fresh and shows as stale in /api/health.
   */
  async _hydrateFromRedis() {
    if (this._hydrated) return;
    // A failed hydrate must be RETRIED, not written off for the life of the process. Setting
    // the flag before the await would mean a Redis that was slow for five seconds at boot —
    // exactly what a redeploy restarting app and Redis together produces — left the adapter
    // permanently cold, and the flood returns the moment the sweep refills past the 30% guard.
    // Throttled so the retry cannot cost a 5s timeout on every 5s poll.
    if (Date.now() < this._hydrateRetryAt) return;
    try {
      // Bounded: a slow Redis must delay the first poll, never hang it. The timer is cleared
      // explicitly — an uncleared 5s handle keeps a test runner's process alive after the
      // assertions pass.
      let timer;
      const cached = await Promise.race([
        state.getAllProducts(this.id),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), 5000); }),
      ]).finally(() => clearTimeout(timer));

      let loaded = 0;
      let outOfScope = 0;
      for (const [sku, product] of Object.entries(cached || {})) {
        if (!product || !product.name) continue;
        // Redis holds rows written under older scope rules — EB Games carried accessories until
        // scope was centralised on 2026-09-08 — so a hydrate must not re-admit them.
        if (!isInScopeName(product.name)) { outOfScope++; continue; }
        // A push that landed before the first poll is first-hand and already confirmed.
        if (this._knownProducts.has(sku)) continue;
        this._knownProducts.set(sku, product);
        this._unconfirmed.add(sku);
        loaded++;
      }
      this._hydrated = true;
      this._pushesSinceHydrate = 0;
      logger.info(`EB Games: hydrated ${loaded} products from Redis`
        + `${outOfScope ? ` (${outOfScope} out of scope, skipped)` : ''}`
        + ' — awaiting the browser sweep to confirm them');
    } catch (err) {
      // Degraded, not broken: the catalogue rebuilds as the extension sweeps. Say it loudly,
      // because this is precisely the condition that produces the restart flood.
      this._hydrateRetryAt = Date.now() + HYDRATE_RETRY_MS;
      logger.warn(`EB Games: catalogue hydration failed (${err.message}) — cold start, `
        + `stale cleanup may fire spuriously until the retry in ${Math.round(HYDRATE_RETRY_MS / 1000)}s`);
    }
  }

  /**
   * Drop hydrated rows the browser has swept past without ever re-sending.
   *
   * Hydration is a bridge across the minutes a sweep takes, not a permanent copy. A row the
   * sweep has walked over several times without seeing is genuinely delisted, and keeping it
   * would make it immortal: every poll rewrites it with a fresh 7-day TTL. Dropping it hands it
   * to poll-adapter's normal stale path, which marks it out of stock rather than deleting it,
   * and raises no event (events.js has no out-of-stock type).
   *
   * Counted in PUSHES, never in elapsed time. An earlier version compared `_lastPushAt` against
   * the hydration timestamp, which reads as "30 minutes of sweeping" but is really "30 minutes
   * on the clock": a laptop asleep for an hour would satisfy it the instant the browser woke
   * and landed a single page, evicting the entire unconfirmed catalogue at once. That drops
   * straight into poll-adapter's stale cleanup and re-creates the exact flood this change
   * exists to stop — and the `newCount < oldCount * 0.3` guard only catches it when more than
   * ~70% goes at once, so the whole band below that would alert. Pushes only accrue while the
   * browser is actually working, so sleep contributes nothing.
   *
   * The share cap is the second guard, and it is the codebase's existing MAX_DROP_SHARE rule:
   * a real delisting trickles, so a LARGE unconfirmed set never means "these all vanished" —
   * it means the sweep is not reaching those pages (the extension resets both tabs to page 1
   * on reload, options change and its 90s watchdog, so deep pages can be starved). Evicting on
   * that evidence would be the flood again, so it evicts nothing and says so.
   */
  _evictUnconfirmed() {
    if (this._unconfirmed.size === 0) return;
    if (this._pushesSinceHydrate < HYDRATE_GRACE_PUSHES) return;

    const share = this._unconfirmed.size / Math.max(1, this._knownProducts.size);
    if (share > MAX_DROP_SHARE) {
      if (!this._evictShareWarned) {
        this._evictShareWarned = true;
        logger.warn(`EB Games: ${this._unconfirmed.size}/${this._knownProducts.size} products still `
          + `unconfirmed after ${this._pushesSinceHydrate} pushes (${Math.round(share * 100)}%) — `
          + 'that is a sweep not reaching its deep pages, not a delisting. Evicting nothing.');
      }
      return;
    }

    const dropped = this._unconfirmed.size;
    for (const sku of this._unconfirmed) this._knownProducts.delete(sku);
    this._unconfirmed.clear();
    logger.info(`EB Games: dropped ${dropped} hydrated product(s) the sweep never confirmed `
      + `across ${this._pushesSinceHydrate} pushes — treating them as delisted`);
  }

  // Until one complete crawl has been stored, write the catalog straight into Redis so products
  // a partial first crawl missed don't surface later as a NEW_SKU alert storm
  async _seedRedis(complete) {
    try {
      const existing = await state.getAllProducts(this.id);
      const missing = [...this._knownProducts.entries()].filter(([sku]) => !existing[sku]);
      if (missing.length > 0) {
        const pipeline = state.getRedis().pipeline();
        for (const [sku, product] of missing) {
          pipeline.set(`tcg:product:${hashSku(this.id, sku)}`, JSON.stringify(product), 'EX', 86400 * 7);
        }
        await pipeline.exec();
        logger.info(`EB Games: seeded ${missing.length} catalog products into Redis (no alerts)`);
      }
      if (complete) this._seeded = true;
    } catch (err) {
      logger.warn(`EB Games: Redis seed failed: ${err.message}`);
    }
  }

  /**
   * Watchlist fast-poll for a single SKU. Odoo only resolves /shop/{templateId}, so the SKU is
   * mapped through the crawled catalog, or looked up via search (which matches default_code).
   */
  async fetchProductPage(sku) {
    const id = String(sku);
    let templateId = this._knownProducts.get(id)?.templateId;
    if (!templateId) templateId = await this._lookupTemplateId(id);
    if (!templateId) {
      logger.warn(`EB Games: WATCHLIST ${id} — SKU not found on site`);
      return null;
    }

    const start = Date.now();
    await this._throttle();
    const html = await this.stealthFetch(`${this.url}/shop/${templateId}`, { ...STEALTH_OPTS, maxRetries: 1 });
    if (isChallenge(html)) throw new Error('Cloudflare challenge');

    const ld = this._productJsonLd(html);
    if (!ld) {
      logger.warn(`EB Games: WATCHLIST ${id} — no product JSON-LD on page`);
      return null;
    }

    const availability = ld.offers?.availability || '';
    const inStock = /InStock|PreOrder|LimitedAvailability/i.test(availability);
    const known = this._knownProducts.get(id) || {};
    const pageProductId = html.match(/name="product_id"[^>]*value="(\d+)"/);
    const product = this.classify({
      ...known,
      sku: id,
      name: ld.name || known.name || '',
      price: Number(ld.offers?.price) || known.price || 0,
      currency: 'CAD',
      url: ld.url || known.url || `${this.url}/shop/${templateId}`,
      image: ld.image || known.image || '',
      inStock,
      canAddToCart: inStock && html.includes('id="add_to_cart"'),
      isPreorderable: /PreOrder/i.test(availability) || /pre-?order/i.test(ld.name || ''),
      seller: 'EB Games',
      shipsToHome: true,
      templateId: String(templateId),
      _productId: pageProductId ? pageProductId[1] : known._productId || null,
      gtin: ld.gtin || known.gtin || null,
    });
    product._watchlist = true;
    this._knownProducts.set(id, product);
    logger.info(`EB Games: WATCHLIST ${id} — "${product.name}" | inStock=${inStock} | $${product.price} | ${Date.now() - start}ms`);
    return product;
  }

  async _lookupTemplateId(sku) {
    try {
      const html = await this._fetchListing(`${this.url}/shop?search=${encodeURIComponent(sku)}`);
      for (const m of html.matchAll(CARD_RE)) {
        const parsed = parseCard(m[0], this.url, 'other');
        if (parsed?.sku === sku) return parsed.templateId;
      }
    } catch (err) {
      logger.warn(`EB Games: SKU lookup failed for ${sku}: ${err.message}`);
    }
    return null;
  }

  _productJsonLd(html) {
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const data = JSON.parse(m[1]);
        const product = (Array.isArray(data) ? data : [data]).find(i => i['@type'] === 'Product');
        if (product) return product;
      } catch { /* not a product block */ }
    }
    return null;
  }
}

module.exports = EBGamesAdapter;
