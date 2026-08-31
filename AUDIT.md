# TCG Monitor — Hostile Code Audit

**Auditor:** Claude Opus 4.6 (hostile senior reviewer)
**Date:** 2026-08-31
**Commit:** bcd8eeb (post retailer-persistence fix)
**Scope:** Every file under `src/`, `admin-ui/`, `scripts/`, `tests/`, plus Dockerfile, docker-compose.yml, package.json, .env.example
**Syntax check:** 31/31 files pass `node --check`
**Tests:** 39/39 pass (`npm test`)

---

## P0 — Will break in production / Security

### P0-1: Proxy credentials committed to git
**Location:** `src/config/proxies.json:3-13`
**What happens:** Anyone with repo access (public or shared) gets 10 ISP proxy credentials with usernames and passwords in plaintext.
**Why:** Proxy URLs are committed directly to the config file instead of loaded from env.
**Fix:** Remove `proxies.json` from git, add it to `.gitignore`, load exclusively from `ISP_PROXY_CONFIG` env var. Rotate all 10 proxy credentials immediately — they are in git history forever.

### P0-2: Admin API key exposed via unauthenticated `/api/bootstrap` endpoint
**Location:** `src/admin/server.js:29-31`
**What happens:** Anyone who can reach the admin port gets the API key by hitting `GET /api/bootstrap`. The auth middleware explicitly skips `/bootstrap` (line 17). This gives full admin access — enable/disable retailers, change channels, view proxy stats.
**Why:** Designed for dashboard auto-connect convenience, but it completely negates the API key auth.
**Fix:** Remove the `/api/bootstrap` endpoint entirely. Have the dashboard prompt for the API key or load it from a cookie/localStorage.

### P0-3: API key comparison is not timing-safe
**Location:** `src/admin/server.js:20`
**What happens:** `key !== config.admin.apiKey` uses JavaScript's `!==` which short-circuits on the first differing byte. An attacker can brute-force the key character by character using timing analysis.
**Why:** Should use `crypto.timingSafeEqual()`.
**Fix:** `const { timingSafeEqual } = require('crypto'); const a = Buffer.from(key); const b = Buffer.from(config.admin.apiKey); if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401)...`

### P0-4: Default API key is "changeme" with no startup validation
**Location:** `src/config/index.js:18`
**What happens:** If `ADMIN_API_KEY` env var is unset, the API key defaults to `"changeme"`. Combined with P0-2 (bootstrap endpoint), the admin dashboard is wide open.
**Why:** No startup validation that required env vars are set.
**Fix:** Fail fast at startup if `ADMIN_API_KEY` is unset or is the default value. Same for `DISCORD_TOKEN` and `REDIS_URL`.

### P0-5: Partial adapter result causes mass false RESTOCK flood
**Location:** `src/core/scheduler.js:95-96`, `src/core/events.js:75-84`
**What happens:** If an adapter returns a PARTIAL product list (e.g. Walmart returns 5 of 20 products because one search URL timed out), `diffProducts()` only iterates `newProducts`. The 15 missing SKUs are NOT diffed — no problem yet. BUT at line 116-122, the scheduler **deletes stale products** from Redis: any SKU in `oldProducts` but not in `newProducts` gets deleted. Next successful poll returns all 20 products → all 15 "deleted" SKUs are detected as NEW_SKU events → **mass false alert flood**.
**Why:** The stale cleanup assumes a successful poll returns the COMPLETE product list. Partial results (from adapter errors caught silently per-URL) violate this assumption.
**Fix:** Only run stale cleanup when the adapter signals a complete result. Add a `{ complete: boolean }` return signal, or skip stale cleanup when the new product count is significantly less than old (e.g. `< oldCount * 0.5`).

### P0-6: No body size limit on Express
**Location:** `src/admin/server.js:12`
**What happens:** `express.json()` with no `limit` option defaults to 100KB, which is actually fine. BUT there's no rate limiting at all — an attacker can spam the API with thousands of requests per second, writing to Redis and disk.
**Why:** No rate limiting middleware.
**Fix:** Add `express-rate-limit` or a simple in-memory counter. At minimum, limit write endpoints to 10 req/sec.

### P0-7: XSS in admin dashboard via retailer names
**Location:** `admin-ui/app.js` — `loadRetailers()` function
**What happens:** Retailer names from the API are interpolated into HTML via template literals (e.g. `` `<div class="r-name">${r.name}...` ``). If an admin adds a retailer with name `<img src=x onerror=alert(1)>`, it executes in every dashboard session.
**Why:** No HTML escaping on user-supplied data rendered into the DOM.
**Fix:** Use `textContent` instead of `innerHTML`, or escape HTML entities before interpolation.

---

## P1 — Wrong behavior under realistic conditions

### P1-1: First scrape of any store fires mass NEW_SKU flood
**Location:** `src/core/events.js:16-23`, `src/core/scheduler.js:95-96`
**What happens:** When a retailer is first enabled, Redis has no cached products. The first poll discovers every product as new → `detectEvents(null, newProd)` fires NEW_SKU for each one. 50+ alerts hit Discord at once.
**Why:** No "first-run seeding" mode that caches products without firing events.
**Fix:** The event type toggles (just added) mitigate this — admin can disable NEW_SKU before onboarding. For a proper fix, add a `seedMode` flag that on first poll saves products to Redis without running `diffProducts()`.

### P1-2: Free-tier alerts lost on restart
**Location:** `src/discord/delivery.js:141-149`
**What happens:** Free-tier delivery uses `setTimeout(delay)` in memory. If the server restarts during the delay window (45 seconds), all pending free-tier alerts are silently lost.
**Why:** In-memory setTimeout is not durable. Railway redeploys kill the process.
**Fix:** Persist delayed events in Redis with a `deliverAt` timestamp and poll on startup. Or accept the loss and document it — free tier is best-effort.

### P1-3: Dedup suppresses legitimate second restocks within 1 hour
**Location:** `src/discord/dedup.js:6`
**What happens:** Dedup TTL is 1 hour. If a product restocks, goes OOS, then restocks again within 60 minutes, the second restock alert is silently suppressed.
**Why:** The dedup key is `type:retailer:sku` with a flat 1-hour TTL. No state tracking for OOS→in-stock transitions between dedup windows.
**Fix:** Either reduce TTL to 5-10 minutes, or make the dedup key include a hash of the stock state so OOS→restock→OOS→restock generates unique keys.

### P1-4: `enabledEvents` toggles read from stale `require()` cache in delivery.js
**Location:** `src/discord/delivery.js:10-14`
**What happens:** `channelsConfig` is loaded once at module init via `require('../config/channels.json')`. When you save config via the dashboard, `channels.json` is written to disk. But `delivery.js` still uses the cached old version. Event type toggles don't take effect until server restart.
**Why:** `require()` caches modules. The `reloadChannels()` method exists (line 29-34) but is never called after saving channels config via the admin API.
**Fix:** In the `PUT /channels` route handler in `routes.js`, call `delivery.reloadChannels()` after writing the file.

### P1-5: Shopify price heuristic incorrectly divides legitimate high prices
**Location:** `src/adapters/shopify.js:111-113`
**What happens:** Any Shopify product with price > $500 CAD gets divided by 100. A $599.99 booster box case becomes $6.00 in the alert. A subsequent poll reads the correct $599.99 → fires a false PRICE_CHANGE alert.
**Why:** The heuristic `if (price > 500) price = price / 100` assumes prices > 500 are in cents. Many TCG sealed cases legitimately cost $500-$800 CAD.
**Fix:** Raise the threshold to 5000+ (no TCG product costs $5000), or better yet check `variant.price` type — Shopify's JSON API returns prices as strings like `"19.99"`, not `1999`.

### P1-6: Discord slash commands re-registered on every boot
**Location:** `src/discord/bot.js:46, 50-79`
**What happens:** `registerCommands()` calls `rest.put(Routes.applicationGuildCommands(...))` on every startup. This is idempotent (PUT replaces all commands) so it's not breaking, but it's a wasted API call and Discord rate-limits command registration to 200 creates/day per guild.
**Why:** No check for whether commands are already registered.
**Fix:** Compare existing commands before registering, or register commands from a separate setup script.

### P1-7: `/status` and `/retailers` commands don't use deferReply — will timeout on 36 retailers
**Location:** `src/discord/bot.js:82-117`
**What happens:** `handleStatus()` loops through all retailers, making Redis calls for each one. With 36 retailers, this can exceed Discord's 3-second interaction response deadline → `Unknown interaction` error.
**Why:** Only `/scan` uses `deferReply()`. The other commands respond directly.
**Fix:** Add `await interaction.deferReply({ ephemeral: true })` and use `editReply()` for `/status` and `/retailers`.

### P1-8: `channels.json` persists on ephemeral filesystem — same problem as retailers.json
**Location:** `src/admin/routes.js` — channels save route, `src/config/channels.json`
**What happens:** Channel config (tier routing, event toggles, role pings) is saved to `channels.json` on disk. Railway deploys reset it to git defaults. All channel routing and event toggle changes are lost.
**Why:** Same root cause as the retailer persistence issue — ephemeral filesystem.
**Fix:** Persist `channels.json` content in Redis (same pattern as retailer overrides). Also affects `products.json` (keywords, tracked SKUs).

---

## P2 — Reliability, resource leaks, missing guards

### P2-1: No process-level unhandled rejection / uncaught exception handlers
**Location:** `src/index.js`
**What happens:** An unhandled promise rejection in any adapter, delivery, or timer callback crashes the entire process. Node 20 terminates on unhandled rejections by default.
**Why:** No `process.on('unhandledRejection')` or `process.on('uncaughtException')` handlers.
**Fix:** Add handlers that log the error and gracefully shutdown, or at minimum prevent a single bad adapter from killing the whole monitor.

### P2-2: Redis disconnect silently stops all state operations
**Location:** `src/core/state.js:10-14`
**What happens:** ioredis reconnects automatically, but during disconnection all `getProduct/setProduct/getAllProducts` calls throw. The scheduler catches these per-adapter and counts them toward the circuit breaker. But dedup, delivery filtering, and admin routes all crash with unhandled Redis errors.
**Why:** No offline queueing config, no connection state checks before operations.
**Fix:** Set `enableOfflineQueue: true` (ioredis default, but verify), and add try-catch in dedup `filterDuplicates` to pass events through on Redis failure (fail-open for alerts).

### P2-3: `getAllProducts()` uses KEYS command — O(N) full keyspace scan
**Location:** `src/core/state.js:40`
**What happens:** `redis.keys('tcg:product:walmart:*')` scans the entire Redis keyspace. With 30 retailers × 1000 products = 30,000 keys, this blocks Redis for the duration. Called every poll from `/stats/products` and every 10s from the dashboard.
**Why:** `KEYS` is documented as "only for debugging" by Redis.
**Fix:** Use `SCAN` with cursor iteration, or maintain a Redis SET of SKUs per retailer.

### P2-4: setInterval timers leak if adapter is re-registered
**Location:** `src/core/scheduler.js:210-214`
**What happens:** `start()` creates `setInterval` timers per adapter. If `start()` is called twice (or a hot-reload mechanism is added), timers double up. There's no `stop()` + `start()` sequence guarding against this.
**Why:** The `running` flag prevents `start()` from being called twice, but there's no cleanup of individual adapter timers when adapters are added/removed at runtime.
**Fix:** Clear existing timers in `start()` before creating new ones.

### P2-5: Costco sitemap scan has no concurrency limit
**Location:** `src/adapters/costco.js:115-117`
**What happens:** `scanSitemaps()` iterates sub-sitemaps sequentially (OK), but each sitemap can contain thousands of URLs. The `knownProductIds` Set grows unbounded. With a large sitemap, memory usage spikes.
**Why:** No cap on `knownProductIds` size or age-based eviction.
**Fix:** Cap `knownProductIds` at a reasonable size (e.g. 5000) and prune entries older than 30 days.

### P2-6: No CORS restriction — any origin can call the admin API
**Location:** `src/admin/server.js:11`
**What happens:** `app.use(cors())` with no origin restriction allows any website to make cross-origin requests to the admin API. Combined with the bootstrap endpoint (P0-2), any page can grab the API key and make authenticated requests.
**Why:** Convenience CORS config.
**Fix:** Restrict to specific origins or remove CORS entirely (dashboard is served from the same origin).

### P2-7: Webhook delivery has no retry on 429 (Discord rate limit)
**Location:** `src/discord/delivery.js:255-263`
**What happens:** If a webhook returns 429, the `sendWebhook` method throws an error. The event is logged as failed and dropped.
**Why:** No retry logic for webhooks, unlike the bot delivery which uses `channel.send()` (discord.js handles rate limits internally for bot API calls).
**Fix:** Parse the `Retry-After` header from 429 responses and retry after the specified delay.

### P2-8: Non-atomic JSON file writes can corrupt config
**Location:** `src/admin/routes.js` — all `fs.writeFileSync` calls
**What happens:** If the process crashes mid-write (or two concurrent requests write simultaneously), the JSON file can be truncated/corrupted, making `JSON.parse` throw on next read and crashing the server.
**Why:** `writeFileSync` is not atomic. No write-to-temp-then-rename pattern.
**Fix:** Write to a temp file, then `fs.renameSync()` (atomic on same filesystem). Or since we're moving to Redis (P1-8), this becomes moot.

### P2-9: Browser module uses single global instance — proxy conflict
**Location:** `src/utils/browser.js:17-52`
**What happens:** `getBrowser()` caches a single global Chromium instance. The first adapter to call `browserFetch()` sets the proxy. All subsequent adapters reuse that instance with the WRONG proxy.
**Why:** Browser is launched with the proxy of whoever calls first, then reused for everyone.
**Fix:** The `cookie-session.js` module does this correctly (caches per proxy URL). Remove `browser.js` or make it cache per proxy URL too.

### P2-10: No request timeout on webhook POST
**Location:** `src/discord/delivery.js:255-259`
**What happens:** `fetch(url, { method: 'POST', ... })` has no timeout. A hanging Discord webhook stalls the delivery queue forever.
**Why:** Missing AbortController timeout.
**Fix:** Add a 10-second timeout via AbortController, same pattern as `httpGet`.

---

## P3 — Code quality, dead code, inconsistency

### P3-1: `cookies.js` (cookie jar module) is imported nowhere
**Location:** `src/utils/cookies.js`
**What happens:** Dead code. The `getJar()`/`clearJar()` functions are never called.
**Why:** Superseded by `cookie-session.js` but never deleted.
**Fix:** Delete `src/utils/cookies.js`.

### P3-2: `got-scraping` and `http-cookie-agent` are unused dependencies
**Location:** `package.json:17-18`
**What happens:** These packages are installed but never imported anywhere in the codebase.
**Why:** Leftover from an earlier HTTP approach before switching to `impit`.
**Fix:** `npm uninstall got-scraping http-cookie-agent` — saves ~2MB from node_modules.

### P3-3: `_template.js` adapter is registered if retailer config references it
**Location:** `src/adapters/_template.js`, `src/index.js:21-29`
**What happens:** The ADAPTER_MAP doesn't include `_template`, so it would just log `Unknown adapter: _template` and skip. Not a bug, but confusing.
**Why:** Template file left in adapters directory.
**Fix:** Move to `docs/` or add to `.gitignore`.

### P3-4: Inconsistent channels.json reload
**Location:** `src/discord/delivery.js:29-34` vs admin route
**What happens:** `reloadChannels()` exists but is only called from the admin `PUT /channels` route — but actually checking the routes file, it's NOT called there either. The method is dead code.
**Why:** The save route writes the file but never signals delivery.js to reload.
**Fix:** Call `delivery.reloadChannels()` in the save handler (this also fixes P1-4).

### P3-5: docker-compose exposes Redis port 6379 publicly
**Location:** `docker-compose.yml:21`
**What happens:** `ports: ["6379:6379"]` binds Redis to all interfaces. In cloud deployments, this exposes an unauthenticated Redis to the internet.
**Why:** Convenience for local dev, dangerous in production.
**Fix:** Remove the Redis `ports` mapping (the app connects via Docker network) or bind to localhost only: `"127.0.0.1:6379:6379"`.

### P3-6: `.env.example` missing `ISP_PROXY_CONFIG` and `PROXY_COST_PER_GB_ISP`
**Location:** `.env.example`
**What happens:** The two env vars used for ISP proxy config in production are not documented.
**Why:** Added later, `.env.example` not updated.
**Fix:** Add `ISP_PROXY_CONFIG=` and `PROXY_COST_PER_GB_ISP=5.00` to `.env.example`.

### P3-7: Dockerfile runs as root
**Location:** `Dockerfile`
**What happens:** The container runs as root. If an attacker exploits a vulnerability (e.g. SSRF via adapter URL), they have full container access.
**Why:** No `USER` directive.
**Fix:** Add `RUN addgroup --system app && adduser --system --ingroup app app` and `USER app` before `CMD`.

### P3-8: `health-check.js` script hardcodes API key
**Location:** `scripts/health-check.js:8`
**What happens:** API key `tcg-admin-test` is hardcoded. Won't work in production unless the API key matches.
**Why:** Test script not updated for configurable API key.
**Fix:** Read from `process.env.ADMIN_API_KEY` or accept as CLI arg.

---

## Needs verification — items I could not confirm

### NV-1: Does ioredis `enableOfflineQueue` actually prevent crashes during Redis disconnect?
**Command:** `redis-cli DEBUG SLEEP 10` during active polling, watch for crashes/error logs.

### NV-2: Does Shopify's `/products.json` ever return prices as integers (cents)?
**Command:** `curl 'https://store.401games.ca/products.json?limit=5' | jq '.products[].variants[].price'` — check if any values are > 500 and actually in cents.

### NV-3: Does the impit Fetch instance leak connections when cached?
**Command:** `lsof -i -n -P | grep node | wc -l` before and after 1 hour of polling.

### NV-4: Are there secrets in git history beyond what's currently in HEAD?
**Command:** `git log --all --diff-filter=D -- '*.env' '.env*' '*secret*' '*token*' '*key*' | head -30`

### NV-5: Does the 50ms sleep in delivery processQueue actually stay under Discord's 50 msg/sec rate limit?
**Command:** Enable 30 retailers, trigger a mass restock, count 429 errors in logs.

---

## Verdict

**Is this safe to run 24/7 against 30 live retailers right now? No.**

The core polling, event detection, and Discord delivery logic is solid and well-structured. The test coverage on `events.js` and `helpers.js` is meaningful (not tautological). The architecture is sound for a single-process monitor.

**What will actually break:**

1. **P0-5 (partial results → stale cleanup → mass false alerts)** is the highest-risk bug. One flaky Walmart search URL returning 0 results will wipe cached SKUs and trigger a flood on the next successful poll. This WILL happen during normal operation.

2. **P0-1 + P0-2** (proxy creds in git + bootstrap endpoint) mean the system is fully open to anyone with repo/network access. Not a runtime crash but a security incident waiting to happen.

3. **P1-8** (channels.json on ephemeral filesystem) means every deploy resets channel routing, event toggles, and role pings — same class of bug as the retailers.json issue just fixed.

4. **P1-4** (stale channelsConfig in delivery.js) means the event type toggles feature just added doesn't actually work until server restart.

**What's fine:** The scheduler's overlap guard, circuit breaker, adapter error isolation, proxy pool management, embed builder, dedup logic (aside from TTL trade-off), and Docker setup are all competent. The 39 tests cover the right things. The code is clean and readable.

**Priority order for fixes:** P0-5 → P1-4 → P0-2 → P0-1 → P1-8 → P0-4 → P0-3 → P2-1 → everything else.
