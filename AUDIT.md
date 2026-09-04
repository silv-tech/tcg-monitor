# Architecture & Cost Audit

Last reviewed: 2026-09-04. Rewritten from a full read-only pass over every adapter,
the scheduler, delivery and config. Earlier versions of this file described an
architecture that no longer exists — if something here disagrees with the code, the
code is right and this file is stale again.

## What this system is

One Node process polls 37 retailers and pushes stock alerts to Discord in seconds.
Redis holds product state; Railway (us-east4) runs the app and Redis. Speed is the
product — a late alert is a worthless alert.

## How each retailer is read

| Retailer | Path | Cost | Notes |
|---|---|---|---|
| Walmart search | impit + CA residential, 7 queries in 2 alternating groups | free | `?selectedSellerId=0` pins Walmart's own offer |
| Walmart watchlist | `DynamicItemById` GraphQL (~7KB) + pinned page every 3rd cycle | free | JSON carries stock count and cart limit |
| Amazon discovery | ScraperAPI search, 3 queries | 15 credits/run | finds new ASINs only — does not gate restock speed |
| Amazon monitor | `aodAjaxMain` offer endpoint (~30KB) | free | also yields offer id + seller, so alerts need no paid enrichment |
| EB Games | Odoo category pages, fast poll + background deep crawl | free | Cloudflare rate-limits above ~2 req/s |
| Best Buy | their own JSON search API, 7 queries in parallel | free | ~10s wall per poll; almost every listing is marketplace |
| Costco | product pages via ISP proxy, sitemap discovery every 6h | free | ScraperAPI only on 403/503 |
| Pokemon Center | sitemap discovery (free) + targeted paid checks | 25 credits/check | see below |
| 31 Shopify shops | `products.json` | free | no anti-bot |

## The two things that actually cost money

**Residential proxy bandwidth, not ScraperAPI.** Bytes × frequency is the real bill.
Amazon's monitor used to pull ~1.9MB pages for 15 ASINs every 2 minutes — about
20GB/day — until it moved to the ~30KB offer endpoint. Before changing any cadence,
work out the bytes it implies. `getStats()` now reports measured bytes and a
projected GB/day rather than assuming a flat 300KB per request.

**ScraperAPI credits.** 100,000/month. Amazon discovery is effectively the whole
bill; at a 30-minute interval that is ~21,600/month. The budget guard warns at 80%
and hard-pauses every ScraperAPI caller at 90%, so a runaway caller silently stops
paid fetches system-wide.

## Anti-bot reality per site

Each site needed a different answer; none of them generalise.

- **Walmart** — PerimeterX. HTTP-only stealth works at ~8s search cadence; 5s dropped
  success to ~50%. Product pages are edge-cached (this cost ~70s on a live drop),
  the JSON endpoint is `no-store`.
- **Amazon** — soft-blocks `/dp/` with a "continue shopping" interstitial that carries
  no captcha marker, so it reads as a parse failure. The AOD endpoint is not gated.
- **EB Games** — Cloudflare. impit only passes with cert verification off, which
  changes the TLS ClientHello. 750ms global request spacing avoids 429s.
- **Pokemon Center** — DataDome 403s every HTTP client regardless of TLS fingerprint
  or IP, *and* Incapsula serves headless Chromium a block iframe. Only ScraperAPI
  ultra_premium gets through, at 25 credits. Its sitemap is exempt, so discovery is
  free and availability is not. Paid checks are therefore spent only on products that
  just appeared in the sitemap plus watchlisted SKUs — never a catalog sweep.

## Per-store speed control

`intervalMs` plus an optional `timing` block per retailer in `retailers.json`, both
overridable at runtime via `PATCH /api/retailers/:id` or `/speed`, persisted in Redis
and applied live by `scheduler.updateAdapter`. Adapters read cadences through
`base.timingValue`, which clamps each value to a floor that site's anti-bot tolerates
and logs when it does — a bad value cannot get the proxy pool banned.

Keys: `watchlistIntervalMs`, `discoveryIntervalMs`, `deepCrawlIntervalMs`,
`minSpacingMs`, `checksPerPoll`, `pollTimeoutMs`.

## Traps worth knowing

- **Redis overrides beat `retailers.json`.** The file said 29 Shopify stores were
  disabled while all 31 were running. Startup now logs every drift and the effective
  config; trust that log, not the file.
- **The 500-product cap truncates a sorted key set.** With insertion order the kept
  subset rotated, which re-fired `NEW_SKU` for old products and left a 7-day Redis key
  behind for every product that ever cycled through (~227k keys accumulated).
- **`/scan` posts one message per cached product**, capped at 25 per retailer. Above
  that it would block real restock alerts behind it in the delivery queue.
- **Watchlist polling is independent of the search circuit breaker.** It used to share
  it, so five failed search polls silently stopped drop detection for five minutes.
- **Watchlist alerts bypass the delivery queue** and post to both channels in
  parallel, so a slow enrichment on another retailer cannot delay a drop.
- **Dedup is 45s for watchlist restocks**, 10 minutes otherwise — drop waves arrive
  minutes apart and the long window swallowed every wave after the first.

## Open questions

- Real cost per GB on the CA residential pool. Every bandwidth figure uses the
  $12/GB placeholder in `proxy.js`.
- Whether Pokemon Center availability is worth its 25-credit-per-check price at all,
  or whether sitemap-driven new-product alerts are the only part worth keeping.
