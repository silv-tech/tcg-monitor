# Deploying the Amazon bridge as its own narrow service

A second Railway service off **this same repo**, running Amazon alone, so the browser bridge
(`amazon-extension/`) can be exercised without waking the full 19-retailer monitor.

One codebase on purpose. The extension's `page.js` chooses which elements to send and
`src/utils/amazon-buybox.js` decides what they mean — that is one contract, and splitting it across
two repos would let the halves drift apart silently.

## Why not just edit retailers.json

Because the edit would live on a branch, and merging that branch would silently disable those
retailers in production. `RETAILERS_ONLY` exists instead: a boot-time allowlist that narrows a
deployment without the config file on disk ever disagreeing with production. Unset, it changes
nothing at all — there is a test pinning that.

## Railway setup

New service in the **tcg-monitor** project (or a new project — either works; a new project keeps
the paused production service completely untouched, which is the safer choice):

1. **Source:** `silv-tech/tcg-monitor`, branch **`amazon-bridge`**.
2. **Add a Redis service** and reference it, so `REDIS_URL` is injected. It must be a **fresh**
   Redis — see the warning below.
3. **Generate a domain.** The extension POSTs to it, so it has to be reachable. Add that host to
   `amazon-extension/manifest.json` → `host_permissions` if it is not already covered by
   `https://*.up.railway.app/*`.
4. Set the variables below.

### Variables — the minimum

| variable | value | why |
|---|---|---|
| `RETAILERS_ONLY` | `amazon` | the whole point; every other retailer is forced off |
| `ADMIN_API_KEY` | a **new** random key | the bridge authenticates with this. Do not reuse production's |
| `NODE_ENV` | `production` | |
| `LOG_LEVEL` | `info` | `debug` if the bridge is misbehaving |
| `REDIS_URL` | injected by the Redis reference | |

### Deliberately left unset at first

| variable | leaving it unset means |
|---|---|
| `DISCORD_TOKEN` | the process logs `No DISCORD_TOKEN — running without Discord` and sends **nothing anywhere**. This is what you want for the first run: the bridge can be proven end to end with zero risk of traffic reaching the client |
| `SCRAPER_API_KEY` | Amazon's paid lanes cannot spend. A missing key reads as INCONCLUSIVE, never as out-of-stock, so it degrades safely |
| `AMAZON_PRIORITY_OFFERS` | set to `0` if you *do* add a ScraperAPI key but still want the paid priority lane off |
| `PAID_CHANNEL_ID`, `FREE_CHANNEL_ID`, `PAID_WEBHOOK_URL`, `ADMIN_CHANNEL_ID` | no channels to route to. Add a **test** guild and channel later if you want to see real alert embeds; never point this service at the client's channels |

Everything else in production's 44 variables is for retailers this service does not run
(`SHOPIFY_RATE`, `SHOP_*`, `EBGAMES_*`, `ISP_PROXY_CONFIG`, `PROXY_*`, `BRIGHTDATA_*`,
`PROTECTED_ISP_RETAILERS`) or is Railway-injected (`RAILWAY_*`, `PORT`).

> **Use a fresh Redis, not production's.** Sharing it would have this service write Amazon stock
> into the state the paused production monitor will diff against when it comes back — which turns
> every row this service touched into a phantom transition, straight into the client's Discord.

## First run, in order

1. Deploy and check the boot log for both lines:

   ```
   RETAILERS_ONLY=amazon — this process runs 1 retailer(s) only (amazon); every other retailer
     is forced off regardless of retailers.json or its Redis override.
   Effective config: 1/19 retailers enabled — amazon@6s
   ```

   If the second line says anything other than `1/19`, stop and fix that first.

2. `GET /api/health` should answer. Then check the queue is populated:

   ```
   curl -s -H "x-api-key: $ADMIN_API_KEY" "$BASE/api/ingest/amazon/next?n=3"
   ```

   An empty `items` array is expected on a cold start — the queue is built from
   `_knownProducts`, which fills from the watchlist seed and the first search passes. Give it a
   few polls.

3. Load the extension in the **Canadian** Chrome (`chrome://extensions` → Developer mode → Load
   unpacked → `amazon-extension/`), fill in the URL and key, tick Enabled, and watch the options
   log.

## Reading the first result — this is the actual test

The selector ids in `page.js` have **never been run against a live amazon.ca page**. This first
cycle is what settles them.

| options log says | meaning |
|---|---|
| `pushed 12 — 12 read` | the selectors are right. Move on |
| `12 read nothing — 12x http200 no-title 512kb [corePrice_feature_div,availability]` | the page loaded fine and `#productTitle` is wrong. The bracket lists the ids that **did** match, which names what to fix |
| `12 read nothing — 12x http200 no-title 480kb [no known ids]` | none of them match. The page shape is different from what was assumed |
| `blocked (captcha …) — pausing 60min` | Amazon challenged the session. Do not shorten the pause; report the number of reads that got through first |
| `12x http200 short 2453b` | not a product page at all — likely a redirect to a sign-in or locale page |

Send me that line verbatim and it says exactly what to change.

## When it works

Merge `amazon-bridge` to master, and the bridge can run against the real monitor. At that point
the priority set moves from the paid lane's 180s to roughly 90s at no credit cost — see
`amazon-extension/README.md` for the cadence table and the half-batch rule.
