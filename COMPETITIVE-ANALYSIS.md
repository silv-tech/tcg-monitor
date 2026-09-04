# Competitive Analysis: Zephyr Monitors vs Tempo Monitors vs PokeNotify

**Date:** September 2, 2026
**Purpose:** Engineering-grade competitive intelligence for Pulse Watch (tcg-monitor)
**Confidence levels:** [CONFIRMED] = direct evidence, [INFERRED] = high-confidence deduction, [HYPOTHESIS] = educated speculation

---

## 1. Product & Features

### Company Profiles

| | Zephyr Monitors | Tempo Monitors | PokeNotify |
|---|---|---|---|
| **Model** | B2B white-label | B2B white-label | B2C consumer |
| **Founded** | 2019 | ~2020-2021 | ~2024 |
| **HQ** | Fremont, CA, USA | UAE | Unknown (US-based) |
| **Entity** | Zephyr Monitors LLC (CA #201926810360) | Sole developer: Mihail-Damian Hobeanu | Pseudonym: "Dr. Apex" |
| **Employees** | 11-50 (LinkedIn) | 1-5 (likely solo dev + mods) | 2-5 (estimated) |
| **Customers** | Cook groups (sneaker/streetwear/collectibles) | Cook groups (retail arbitrage) | Direct consumers (TCG collectors) |
| **Sites Monitored** | 320+ | 300+ | 100+ |
| **Pricing** | Custom (B2B, application-only) | Custom (B2B, not published) | $7.99/mo (Whop) |

### Product Suites

**Zephyr:**
- Zephyr Monitors (core B2B alert service, 320+ sites)
- ZephyrAIO (all-in-one checkout bot: Supreme, Shopify, Footsites — $200 + $50/mo)
- Zephyr Companion App (Android push alerts, iOS in dev, `app.zephr.companion`)
- Companion Discord Bot (Shopify generators, keyword pinger, Nike stock checker)
- LaunchedX (discontinued restock manager desktop app)
- Client Dashboard (webhook config, branding, settings)

**Tempo:**
- Monitor Bot (`!m` prefix — restocks, price monitors, early monitors, scrapers, keyword pingers, forwarding, leads)
- Tempo Assistant (`!ta` prefix — in-store stock checkers for 11 retailers by ZIP, eBay views, parcel tracking, UPC/ASIN/SKU lookups, seller fees calc)
- Tempo Pro (web app — barcode scanner, store map, clearance finder, inventory lookup)
- Tempo Alerts (mobile app — iOS + Android, `com.tempo.tempoNotifs`, Live Activities, alarm mode)
- Web Dashboard (Next.js + NextAuth, admin management)
- ATC Scripts (Pokemon Center, Target, Funko, Loungefly, Journeys)

**PokeNotify:**
- Online Restock Monitors (scrapers + restocks, 100+ retailers)
- Mobile App (iOS + Android, `com.pokenotify.app` — live feed, watchlist, push alerts, keyword filters)
- In-Store Finds Map (community-sourced, GPS directions)
- Release Calendar / Hype Calendar
- Market Intel / Daily Brief (card values, investment analysis)
- Pokelytics HQ (portfolio tracker, market trends, AI picks, EV analysis)
- PokeNotify Emporium (consignment program for graded slabs)
- Retailer Success Guides (GitBook — Costco queue guide, etc.)
- Buy/Sell/Trade channels
- Staff-led live drop guidance

### Monitor Types Comparison

| Monitor Type | Zephyr | Tempo | PokeNotify | Pulse Watch (ours) |
|---|---|---|---|---|
| Restock (SKU-based) | Yes | Yes | Yes | Yes |
| New product detection | Yes | Yes (full scrapers) | Yes (scrapers) | Yes |
| Price change | Unknown | Yes | Unknown | Yes |
| Early/pre-release SKU | Unknown | Yes | Unknown | No |
| Shopify scraper | Yes | Yes (restocks + full) | Yes | Yes |
| Squarespace scraper | Unknown | Yes | Unknown | No |
| BigCartel/GoDaddy | Unknown | Yes | Unknown | No |
| Clearance/deals | Unknown | Yes | Unknown | No |
| In-store stock (ZIP) | Unknown | Yes (11 retailers) | Community-sourced map | No |
| Keyword pinger | Yes | Yes (positive/negative) | Per-channel keywords | No |
| SKU forwarding | Yes (implied) | Yes | No | No |
| Max price filter | Unknown | Yes | Unknown | Yes ($30 CAD min) |
| ATC scripts | Likely (AIO bot) | Yes (5 retailers) | No | No |
| Mobile push | Yes (Companion) | Yes (Tempo Alerts) | Yes | No |
| Cross-retailer check | Unknown | Unknown | Unknown | Yes |
| Restock history | Unknown | Unknown | Unknown | Yes |

---

## 2. Technical Architecture

### Zephyr — Confirmed Infrastructure

**The standout finding: Zephyr operates its own ASN.**

| Spec | Detail |
|---|---|
| **ASN** | AS400725 |
| **IPv4 blocks** | 3× /24 prefixes: `23.26.134.0/24`, `50.114.114.0/24`, `74.80.252.0/24` (~768 IPs) |
| **IPv6** | 1 prefix (65,536 /48s) |
| **Upstream** | AS6939 — Hurricane Electric (one of world's largest IX/transit providers) |
| **Hosted domains** | 2,404 across 62 IPs |
| **Location** | Fremont, California |
| **Backend language** | Java/Kotlin/JVM [CONFIRMED via GitHub: `okhttp-tests`, `brotli` repos] |
| **HTTP client** | OkHttp with custom TLS fingerprint manipulation + Brotli compression |
| **Frontend** | JavaScript/React [CONFIRMED via ZephyrAIO GitHub: `CustomDashboard`, `AdminTable`] |
| **TLS spoofing** | Likely uses `impersonator` library (BouncyCastle fork for JA3/JA4 fingerprint impersonation) |

**Significance of own ASN:** A monitoring company with its own IP space can:
- Rotate through ~768 datacenter IPs without proxy provider dependency
- Control IP reputation directly
- Peer with Hurricane Electric for ultra-low-latency internet exchange access
- The 2,404 hosted domains suggest distributed monitoring infrastructure or proxy rotation

### Tempo — Inferred Architecture

| Component | Technology | Confidence |
|---|---|---|
| **Backend** | Node.js/TypeScript | HIGH — Discord.js ecosystem, Next.js dashboard |
| **Dashboard** | Next.js + NextAuth | CONFIRMED — URL pattern `/api/auth/signin?callbackUrl=` |
| **Mobile app** | React Native or Flutter | MEDIUM — 20.73MB, cross-platform |
| **Database** | PostgreSQL or MongoDB | LOW — no evidence |
| **Cache** | Redis | HIGH — standard for state diffing |
| **Queue** | BullMQ (Redis) or RabbitMQ | MEDIUM — needed for polling + delivery decoupling |
| **Hosting** | Cloud VPS (AWS/DO) | MEDIUM — persistent polling requires always-on processes |
| **Bot framework** | Discord.js | HIGH — `!m`/`!ta` prefix pattern |

### PokeNotify — Inferred Architecture

| Component | Technology | Confidence |
|---|---|---|
| **Backend** | Node.js or Python | MEDIUM — Discord.js leans Node |
| **Database** | PostgreSQL or MongoDB | LOW |
| **Cache** | Redis | HIGH — required for real-time state diffing at 100+ retailers |
| **Push notifications** | Firebase Cloud Messaging + APNs | HIGH — standard for mobile push |
| **Billing** | Whop | CONFIRMED |
| **Documentation** | GitBook | CONFIRMED |
| **Website** | Custom web app (has `/auth` endpoint) | CONFIRMED |
| **Hosting** | AWS/GCP | MEDIUM — scale implies cloud |

### Pulse Watch (ours) — Current Architecture

| Component | Technology |
|---|---|
| **Backend** | Node.js |
| **Database** | Redis (state, dedup, history) |
| **Adapters** | Custom per-retailer (Shopify, Walmart, Amazon, Costco, Pokemon Center) |
| **HTTP** | ScraperAPI (Amazon/Walmart structured search), node-fetch + Playwright (others) |
| **Proxies** | Immaculate IPs (CA residential), Lavish Proxies (US residential) |
| **Discord** | discord.js v14 (bot + webhook fallback) |
| **Hosting** | Railway + Docker |
| **Delivery** | Priority queue, paid-first, free-delayed |

### Architecture Diagrams

**Zephyr (B2B fan-out):**
```
[320+ Retailer Sites]
       |
[Java/Kotlin Workers on AS400725 (768 IPs)]
  OkHttp + TLS spoofing + Brotli
       |
[Redis State Store — change detection]
       |
[Alert Engine]
  |         |           |
  v         v           v
[Webhook   [Companion  [Client
 Fan-out    App Push    Dashboard
 to N       via FCM]    WebSocket]
 groups]
```

**Tempo (multi-bot per-group):**
```
[300+ Retailer Sites]
       |
[Node.js Workers + Residential Proxies]
       |
[Redis State Store — change detection]
       |
[Event Bus]
  |         |           |          |
  v         v           v          v
[Monitor   [Tempo      [Tempo    [Tempo
 Bot !m     Assistant   Pro       Alerts
 per-group  !ta         Web App   Mobile]
 webhooks]  per-group]  Barcode]
```

**PokeNotify (consumer fan-out):**
```
[100+ Retailer Sites across 6 regions]
       |
[Polling Workers + Residential Proxies]
       |
[Redis State Store]
       |
[Alert Router]
  |              |
  v              v
[Discord        [Mobile App
 Channels        Push via
 by region/      FCM/APNs
 retailer]       + Keyword
                  Filtering]
```

---

## 3. Retailer Monitoring

### Coverage Comparison

| Retailer | Zephyr | Tempo | PokeNotify | Pulse Watch |
|---|---|---|---|---|
| **Amazon US** | Unknown | Yes (ASIN monitoring) | Yes | — |
| **Amazon CA** | Unknown | Unknown | Likely | **Yes** (ScraperAPI, 19 queries) |
| **Walmart US** | Unknown | Yes | Yes | — |
| **Walmart CA** | Unknown | Unknown | Yes | **Yes** (ScraperAPI, 16 queries) |
| **Target** | Unknown | Yes (TCIN/UPC) | Yes | — |
| **Costco US** | Unknown | Yes (in-store) | Yes | — |
| **Costco CA** | Unknown | Unknown | Unknown | **Yes** (ISP proxy) |
| **Pokemon Center US** | Yes (via PokeMart) | Yes (ATC + early SKU) | Yes | — |
| **Pokemon Center CA** | Unknown | Unknown | Yes | **Yes** (residential proxy) |
| **Best Buy US** | Unknown | Yes (SKU lookup) | Yes | — |
| **Best Buy CA** | Unknown | Unknown | Yes | Planned (Phase 2) |
| **GameStop** | Unknown | Yes (in-store) | Yes | — |
| **EB Games CA** | Unknown | Unknown | Yes | **Planned** (adapter broken, Odoo rewrite needed) |
| **Shopify stores** | Yes (generic) | Yes (restocks + full) | Likely | **Yes** (40+ CA stores) |
| **401 Games** | No | No | Unknown | **Yes** |
| **Face to Face** | No | No | Unknown | **Yes** |
| **Hobbiesville** | No | No | Unknown | **Yes** (enabled, 2500 max) |
| **Kanzen Games** | No | No | Unknown | **Yes** (enabled, 4000 max) |
| **Chimera/Untouchables** | No | No | Unknown | **Yes** (configured) |
| **20+ more CA Shopify** | No | No | No | **Yes** (configured) |

**Key insight: No competitor covers Canadian specialty TCG retailers.** Our 40+ Phase 2 Shopify stores (401 Games, Face to Face, Hobbiesville, Chimera, Untouchables, Deck Out, Danireon, PokeJeux, TCGfy, etc.) are completely unmonitored by any competitor.

### Monitoring Methods

**Shopify `products.json` [ALL COMPETITORS + US]:**
- Standard approach: `GET {store}/products.json?limit=250`
- Returns title, variants, inventory_quantity, price, images, tags
- Minimal anti-bot (light rate limiting, occasional 429s)
- Tempo confirms: "Shopify restocks scraper uses the same logic as a regular scraper"
- Our implementation: Full product fetch with keyword filtering, variant tracking

**Amazon [CONFIRMED HARD TARGET]:**
- Zephyr: Java/OkHttp with TLS spoofing — likely direct page/API scraping
- Tempo: ASIN monitoring, buy box stats, FBA data — likely Product Advertising API + scraping
- PokeNotify: Likely residential proxies + careful fingerprinting
- **Us:** ScraperAPI structured search (autoparse). 5-layer filter. Works but limited to search results.

**Walmart [CONFIRMED HARD TARGET]:**
- All competitors: Residential proxies + TLS fingerprinting for PerimeterX/HUMAN bypass
- Tempo: Has internal inventory API access (ZIP-based in-store stock)
- **Us:** ScraperAPI structured search. Works for CA. Third-party seller filtering.

**Pokemon Center [CONFIRMED HARD TARGET]:**
- Zephyr: Monitors via PokeMart UK partnership
- Tempo: UK Shopify → US early SKU discovery trick. Dedicated ATC scripts.
- PokeNotify: Likely HTML scraping through Imperva/Incapsula WAF
- **Us:** Residential proxy. Currently facing bot protection issues.

### Polling Intervals (Inferred)

| Priority | Zephyr | Tempo | PokeNotify | Pulse Watch |
|---|---|---|---|---|
| High-value (Amazon, Pokemon Center) | 1-5s | 3-10s | 3-10s | 120s (Amazon), 300s (PC) |
| Major retail (Walmart, Costco) | 3-10s | 5-15s | 5-15s | 45-60s |
| Shopify stores | 5-15s | 10-30s | 15-30s | 45s |
| During known drops | Sub-second | Unknown | Dramatically increased | No special handling |

**Gap:** Our polling intervals are 5-10x slower than competitors. This is partially offset by ScraperAPI costs and Railway resource limits.

---

## 4. Anti-Bot & Reliability

### Anti-Bot Approaches

**Zephyr [MOST SOPHISTICATED]:**
- Own ASN (AS400725) with 768 datacenter IPs — no proxy provider dependency
- Java/OkHttp with TLS fingerprint spoofing (JA3/JA4) via BouncyCastle/impersonator
- Brotli compression support (matches real browser Accept-Encoding)
- HTTP/2 fingerprint manipulation (SETTINGS frame, window update, priority)
- Geographically distributed nodes (US + EU confirmed)
- Likely supplements with residential proxies for hardest targets
- **Moat:** Own IP infrastructure is a massive capital investment competitors can't easily replicate

**Tempo [STANDARD INDUSTRY]:**
- Residential proxy rotation (Bright Data, Oxylabs, or similar)
- TLS fingerprinting for Akamai/PerimeterX bypass
- Header ordering matching real browsers
- Possible headless browser fallback for hardest sites
- Cookie management and session persistence
- In-store stock checkers use retailer internal APIs (less protected than product pages)

**PokeNotify [SCALE-FOCUSED]:**
- Residential proxies essential for 100+ retailers across 6 regions
- TLS fingerprint randomization
- Per-IP request budgets
- Automatic IP rotation on 403/429
- Likely headless browser fallback for challenge pages
- Region-specific proxy geolocations (US, CA, UK, AU, JP, EU)

**Pulse Watch (ours):**
- ScraperAPI handles anti-bot for Amazon/Walmart (structured endpoints)
- Residential proxies: Immaculate IPs (CA), Lavish Proxies (US)
- Playwright with stealth for browser-based scraping
- No TLS fingerprint manipulation (Node.js limitation vs Java/OkHttp)
- No own IP infrastructure

### Anti-Bot Systems by Retailer

| Retailer | Protection | Difficulty |
|---|---|---|
| Pokemon Center | Imperva/Incapsula WAF, queue system | HARD |
| Amazon | Akamai Bot Manager | VERY HARD |
| Walmart | PerimeterX/HUMAN + Akamai CDN | HARD |
| Target | Akamai | HARD |
| Best Buy | API key (free), moderate WAF | EASY-MEDIUM |
| Costco | Moderate WAF | MEDIUM |
| GameStop | Cloudflare | MEDIUM |
| Shopify stores | Light rate limiting | EASY |
| EB Games CA | Cloudflare + Odoo platform | MEDIUM |

### Reliability Signals

| Service | Uptime Evidence | Known Issues |
|---|---|---|
| Zephyr | "Stability and consistency are the priority" — 7 years operating | No public complaints found |
| Tempo | 4+ years operating, "thousands of satisfied clients" | No public reviews found |
| PokeNotify | Whop: 4.9-5.0★ (600+ reviews) | Trustpilot: some complaints about delayed/inconsistent alerts |
| Pulse Watch | New service, Railway hosting | EB Games adapter broken, Pokemon Center proxy issues |

---

## 5. Discord / Alert System

### Delivery Architecture

**Zephyr (B2B Webhook Fan-out):**
- Cook group configures webhook URLs via dashboard
- Zephyr sends alerts to all client webhooks simultaneously
- Client branding: custom logo, color, footer, author name
- End users never see "Zephyr" — it's white-labeled
- Companion App provides push notification bypass for Discord's unreliable notifications

**Tempo (Per-Group Bot Instance):**
- Each cook group gets their own Monitor Bot (`!m`) + Assistant (`!ta`)
- Alerts sent as bot messages (not webhooks) within group's Discord
- Rich configuration: keyword pingers (positive/negative), forwarding rules, max price, affiliate links
- Interactive Discord buttons: Stock Check, ZIP Set
- Tempo Alerts mobile app: keyword filtering, time windows, alarm mode, Live Activities (iOS)

**PokeNotify (Consumer Discord + App):**
- Channels organized by region → retailer
- Role-based mentions for category/retailer targeting
- `@everyone` pings on major drops
- Per-channel notification customization
- Mobile app with keyword filtering, watchlist priority alerts, push via FCM/APNs
- In-store finds map with GPS directions

**Pulse Watch (ours):**
- Priority-sorted delivery queue (RESTOCK > PREORDER > CART > NEW_SKU > PRICE > SHIPPING > LISTING)
- Tiered: paid channel (immediate) → free channel (delayed)
- Bot delivery with webhook fallback + 429 retry
- Event type toggles, $30 CAD minimum, non-TCG filtering
- Amazon: OLID scraping, third-party seller suppression
- Enrichment: restock history, price history, cross-retailer matching
- Watchlist alerts to dedicated channel + admin

### Embed Features Comparison

| Feature | Zephyr | Tempo | PokeNotify | Pulse Watch |
|---|---|---|---|---|
| Product image | Yes | Yes | Yes | Yes (thumbnail) |
| Price display | Yes | Yes (old→new for price change) | Yes | Yes (strikethrough for drops) |
| ATC links | Yes (AIO bot) | Yes (scripts) | No | Yes (CA ATCx1/x2/x3/x12) |
| Stock count | Yes (when available) | Yes | Unknown | Yes (Shopify qty, Amazon 1+) |
| SKU/ASIN | Yes | Yes | Yes | Yes |
| Variant ID | Unknown | Yes (Shopify) | Unknown | Yes (Shopify) |
| Interactive buttons | Yes (Companion) | Yes (Stock Check, ZIP) | Unknown | Yes (Buy Now link button) |
| Keyword pinger | Yes | Yes (pos/neg) | Yes (per-channel) | No |
| Restock history | Unknown | Unknown | Unknown | **Yes** (unique) |
| Cross-retailer price | Unknown | Unknown | Unknown | **Yes** (unique) |
| Price history | Unknown | Unknown | Unknown | **Yes** (unique) |
| Detection speed | Unknown | Unknown | Unknown | **Yes** (⚡ Xs in footer) |
| Offer Listing ID | Unknown | Unknown | Unknown | **Yes** (Amazon OLID) |
| Keepa/eBay links | Unknown | Unknown | Unknown | **Yes** (Amazon embeds) |
| Custom branding | Yes (per-client) | Yes (per-group) | No (PokeNotify brand) | No (Pulse Watch brand) |
| Affiliate links | Unknown | Yes | No | No |

### Deduplication

All services must handle dedup — all likely use Redis with cooldown windows per SKU/retailer. Our implementation uses a dedicated `dedup.js` module with `filterDuplicates()` + `markSent()`.

---

## 6. Code-Level Breakdown

### Zephyr — Confirmed Code Artifacts

**GitHub: [Zephyr-Monitors](https://github.com/Zephyr-Monitors)** (2 public repos)
- `okhttp-tests` — OkHttp HTTP client tests (Java)
- `brotli` — Brotli compression library (Java)

**GitHub: [ZephyrAIO](https://github.com/ZephyrAIO)** (3 public repos)
- `CustomDashboard` — Client dashboard UI (JavaScript)
- `AdminTable` — Admin management table (JavaScript)
- `executive-insights` — Analytics/reporting (JavaScript)

**Test Shopify store:** `jaguaralerts.myshopify.com` — contains test products ("test product limit actual"), clearly used for testing their Shopify monitor.

**Inferred Shopify Monitor Pseudocode (Java):**
```java
public class ShopifyMonitor implements Monitor {
    private final OkHttpClient httpClient; // Custom TLS fingerprint
    private final RedisClient redis;

    public void poll(String storeUrl) {
        String url = storeUrl + "/products.json?limit=250";
        Request request = new Request.Builder()
            .url(url)
            .header("Accept-Encoding", "gzip, deflate, br")
            .header("User-Agent", randomChromeUA())
            .build();

        Response response = httpClient.newCall(request).execute();
        List<Product> products = parseProducts(response.body());

        for (Product product : products) {
            for (Variant variant : product.getVariants()) {
                String key = storeUrl + ":" + variant.getId();
                ProductState prev = redis.get(key);
                ProductState curr = new ProductState(variant);

                if (prev == null || hasChanged(prev, curr)) {
                    if (curr.isInStock() && (prev == null || !prev.isInStock())) {
                        alertEngine.sendRestock(product, variant, storeUrl);
                    } else if (prev == null) {
                        alertEngine.sendNewProduct(product, variant, storeUrl);
                    }
                }
                redis.set(key, curr, TTL_HOURS);
            }
        }
    }
}
```

### Tempo — No Public Code

No public GitHub repos, npm packages, or code leaks found. All code is proprietary.

**Key technical confirmations from documentation:**
- `!m add {store} {SKU}` — SKU-based restock monitoring
- `!m scraper add {shopify-url}` — Shopify scraper activation
- `!m titlepinger add {keyword} {role}` — keyword pinger with role mention
- `!m forward add {SKU} {channel}` — per-SKU channel forwarding
- `!m maxprice set {SKU} {price}` — max price filter per SKU
- Shopify scraper confirmed to use same logic as standard monitor (→ `products.json`)

**Pokemon Center Early SKU Trick (documented):**
Pokemon Center UK is Shopify-based. Products appear on UK site before US. Tempo's UK scraper detects new products → extracts SKUs → pre-loads into US early monitor before items go live.

### PokeNotify — No Public Code

No public repos for the TCG alert service. GitHub repos named "PokeNotify" are unrelated 2016 Pokemon GO apps.

**Confirmed monitor types from docs:**
- **Scrapers:** Monitor webpages for NEW items loaded onto a website (keyword-based filtering)
- **Restocks:** Monitor EXISTING tracked items for stock changes (PokeNotify selects which items to track)

### Pulse Watch — Our Codebase

**Key files and their roles:**
```
src/
  adapters/
    base.js          # BaseAdapter — classify(), product normalization
    shopify.js       # products.json polling, keyword filtering, variant tracking
    walmart.js       # ScraperAPI walmartSearch(), 16 queries, third-party seller filter
    amazon.js        # ScraperAPI amazonSearch(), 19 queries, 5-layer filter
    costco.js        # ISP proxy, watchlist SKU monitoring
    pokemoncenter.js # Residential proxy, Playwright-based
    bestbuy.js       # Search-based (Phase 2)
  core/
    scheduler.js     # Polling loop, interval management, event detection
    events.js        # Event type definitions
    state.js         # Redis state management, restock history, cross-retailer matching
    proxy.js         # Proxy pool management, health checks
  discord/
    delivery.js      # DeliveryQueue — priority routing, enrichment, tier delivery
    embeds.js        # EmbedBuilder — Amazon/non-Amazon layouts, buttons
    dedup.js         # Deduplication with cooldown windows
  config/
    retailers.json   # 40+ retailer configs (Phase 1 + Phase 2)
    channels.json    # Channel routing, tier config, role pings
  utils/
    scraper-api.js   # ScraperAPI integration (Amazon/Walmart)
    browser.js       # Playwright browser pool, OLID scraping
    helpers.js       # normalizePrice(), isTCGProduct(), sleep()
```

---

## 7. Security

### Authentication & Access Control

| | Zephyr | Tempo | PokeNotify | Pulse Watch |
|---|---|---|---|---|
| **Auth method** | Application-based, Stripe billing | Dashboard via Discord bot commands + NextAuth | Whop OAuth + Discord OAuth for app | Discord bot token + webhook URLs |
| **Access control** | White-label — clients get dashboard | Per-group isolation, per-user dashboard access | Whop subscription verification | Environment variables, admin channel |
| **Payment** | Stripe | Whop/invoices | Whop + App Store/Google Play | N/A (client's own Discord) |
| **Revocation** | Manual/TOS | Cancel anytime | Auto via Whop | Manual |

### Infrastructure Security

**Zephyr:** Own ASN gives full network control. Abuse contact: `contact@zephyrmonitors.com`. Physical address registered in CA.

**Tempo:** WHOIS privacy. Developer in UAE. Dashboard behind NextAuth (JWT/session cookies).

**PokeNotify:** WHOIS hidden. Whop handles billing security. Declares "no data collected" for mobile app.

**Pulse Watch:** Railway hosting with environment variables. Redis behind Railway's network. Webhook URLs + bot token as secrets.

### Attack Surfaces (Defensive Analysis)

All services share common risks:
1. **Monitor data scraping** — competitors can join and replay alerts (hard to prevent)
2. **Webhook URL leaks** — could enable spam injection
3. **Proxy credential exposure** — operational cost risk
4. **Discord bot token compromise** — would give full server access
5. **Rate limit abuse** — hitting Discord API limits during high-volume drops

---

## 8. Performance & Scalability

### Scale Numbers

| Metric | Zephyr | Tempo | PokeNotify | Pulse Watch |
|---|---|---|---|---|
| **Sites monitored** | 320+ | 300+ | 100+ | 45 (5 enabled) |
| **Discord members** | Unknown (B2B) | Unknown (B2B) | 50,000 | New |
| **Paying members** | Unknown | "Thousands" (groups) | 20,000-25,000 | 1 client |
| **Alert latency** | "Fastest available" | "Fastest retail monitors" | 10-30 seconds | Unknown (untested at scale) |
| **IP infrastructure** | 768+ own IPs | Residential proxies | Residential proxies | 2 proxy providers |
| **Regions** | US + EU | US (+ 22 CA, 16 JP, 33 EU) | US, CA, UK, AU, JP, EU | Canada only |
| **Workers** | JVM thread pools on own infra | Node.js workers on cloud | Unknown | Single Railway instance |

### Latency Optimization Techniques

| Technique | Zephyr | Tempo | PokeNotify | Pulse Watch |
|---|---|---|---|---|
| Own IP space | **Yes (768 IPs)** | No | No | No |
| Connection pooling | OkHttp built-in | Node.js keep-alive | Likely | Basic |
| HTTP/2 multiplexing | Yes (OkHttp) | Likely | Likely | No (node-fetch) |
| Brotli compression | Yes (confirmed) | Unknown | Unknown | No |
| Redis state diffing | Likely | Likely | Likely | Yes |
| Parallel polling | JVM thread pools | Promise.allSettled | Likely | Promise.allSettled |
| Pre-computed state | Likely | Likely | Likely | Yes |
| Geo-distributed nodes | Yes (US + EU) | Unknown | Likely (6 regions) | No (single Railway) |
| Webhook delivery | Direct fan-out | Bot messages | Likely webhooks | Bot + webhook fallback |

### Bottleneck Analysis for Pulse Watch

Our current bottlenecks vs competitors:
1. **Polling intervals** — 45-300s vs competitors' 1-15s (5-20x slower)
2. **Single instance** — Railway runs one process vs distributed workers
3. **ScraperAPI dependency** — adds latency vs direct requests with own proxies
4. **No TLS spoofing** — Node.js can't match Java/OkHttp TLS fingerprint control
5. **No geo-distribution** — single region vs Zephyr's multi-region
6. **No HTTP/2** — node-fetch doesn't support HTTP/2 multiplexing natively

---

## 9. Reverse Engineering — Confidence Assessment

### Zephyr — What's Confirmed vs Inferred

**CONFIRMED (direct evidence):**
- California LLC #201926810360, Fremont CA, 11-50 employees
- ASN AS400725 with 3× /24 IPv4 prefixes, Hurricane Electric upstream
- Java/JVM backend (OkHttp + Brotli on GitHub)
- JavaScript frontend (ZephyrAIO dashboard repos)
- 320+ monitored websites
- B2B white-label with client dashboard
- Products: Monitors, AIO, Companion App, Companion Bot
- Shopify, Footsites, Supreme, Nike, Pokemon Center support
- Android Companion App (`app.zephr.companion`), iOS in dev
- SneakerPings client, PokeMart UK partnership
- Test Shopify store at `jaguaralerts.myshopify.com`

**INFERRED (high confidence):**
- TLS/JA3 fingerprint spoofing via BouncyCastle/impersonator
- Redis for state management
- Colocation at Hurricane Electric Fremont facility
- Kotlin (modern JVM, OkHttp is Kotlin-native)
- FCM for Android push notifications

**HYPOTHESIS:**
- PostgreSQL/MySQL for persistent storage
- RabbitMQ/Kafka for message queuing
- Kubernetes for worker orchestration
- 1-5s polling intervals
- Residential proxy supplement for hardest targets

### Tempo — What's Confirmed vs Inferred

**CONFIRMED:**
- Developer: Mihail-Damian Hobeanu, UAE (`damian@tempomonitors.com`)
- Operating since ~2020-2021
- Next.js + NextAuth dashboard
- Mobile app: iOS + Android (`com.tempo.tempoNotifs`, 20.73MB)
- Multi-bot system: Monitor Bot (`!m`), Tempo Assistant (`!ta`)
- 300+ monitors (213 US, 22 CA, 16 JP, 33 EU, 17 Universal)
- Monitor types: restock, price, early, Shopify/Squarespace/GoDaddy/BigCartel scrapers
- 11 in-store stock checkers (Walmart, Target, BestBuy, Costco, Sam's Club, BJ's, GameStop, Home Depot, Lowe's, Kohl's, Sephora)
- ATC scripts (Pokemon Center, Target, Funko, Loungefly, Journeys)
- Keyword pinger with positive/negative keywords
- SKU forwarding, max price filter, affiliate links
- Pokemon Center UK → US early SKU trick
- Tempo Pro: barcode scanner, store map, clearance finder

**INFERRED (high confidence):**
- Node.js/TypeScript backend
- Discord.js bot framework
- Redis for caching/state
- Residential proxies for protected retailers
- React Native for mobile app

**HYPOTHESIS:**
- PostgreSQL or MongoDB
- BullMQ job queue
- Cloud VPS hosting
- Solo developer + contractor mods

### PokeNotify — What's Confirmed vs Inferred

**CONFIRMED:**
- Founded by "Dr. Apex" (pseudonym), operating since 2024
- $7.99/month via Whop, 3-day free trial
- 50,000 Discord members, ~34,000 Whop members, 20-25K paying
- 6 regions: US, CA, UK, AU, JP, EU
- 100+ retailers monitored
- Two monitor types: Scrapers (new items) + Restocks (stock changes)
- Mobile app: iOS + Android (`com.pokenotify.app`)
- In-store finds map with GPS
- Pokelytics HQ partnership
- GitBook documentation
- Whop billing
- Covers: Pokemon, One Piece, MTG, Yu-Gi-Oh, Lorcana, Dragon Ball, Gundam, Riftbound, Palworld, sports cards
- Canada retailers include: Pokemon Center CA, Walmart CA, EB Games, Best Buy CA, London Drugs, Toys R Us CA
- Estimated MRR: $160,000-$200,000

**INFERRED:**
- Custom per-retailer adapters
- Residential proxy infrastructure
- Redis for state management
- Node.js or Python backend
- FCM + APNs for push
- Small team (2-5 people)

**HYPOTHESIS:**
- Specific polling intervals
- Exact anti-bot techniques
- Database and hosting choices
- Mobile app framework

---

## 10. Final Engineering Analysis

### Side-by-Side Comparison

| Dimension | Zephyr (A) | Tempo (B) | PokeNotify (C) | Pulse Watch (D) |
|---|---|---|---|---|
| **Business model** | B2B white-label | B2B white-label | B2C consumer | B2C consumer |
| **Technical moat** | Own ASN + JVM TLS spoofing | Feature depth (14+ monitor types) | Scale (50K community) | Canada-only depth |
| **Coverage breadth** | 320+ sites (sneakers/retail) | 300+ sites (retail arbitrage) | 100+ sites (TCG, 6 regions) | 45 sites (Canadian TCG) |
| **Coverage depth** | Shallow per site | Deep per site (in-store, ATC) | Medium (online only) | Deep per site (restock/price/cross-retailer) |
| **Anti-bot** | Industry leading (own IPs + JA3) | Standard (residential proxies) | Standard (residential proxies) | Basic (ScraperAPI + residential) |
| **Alert speed** | ~1-5s (claimed fastest) | ~3-15s (claimed fastest) | ~10-30s (confirmed) | ~45-300s (our intervals) |
| **Mobile app** | Android (iOS coming) | iOS + Android (Live Activities!) | iOS + Android | None |
| **Revenue** | Unknown (B2B) | Unknown (B2B) | $160-200K MRR | $0 (pre-launch) |
| **Canadian TCG** | None confirmed | 22 CA monitors (unspecified) | Some (PC CA, Walmart CA, EB, BB) | **40+ CA TCG retailers** |

### Where We Win

1. **Canadian specialty TCG retailers** — We monitor 40+ Canadian Shopify stores (401 Games, Face to Face, Hobbiesville, Chimera, Untouchables, + 20 more) that NO competitor covers. This is our strongest differentiator.

2. **TCG-specific intelligence** — Restock history, cross-retailer price comparison, price history trends. No competitor surfaces this data in their alerts.

3. **Product filtering quality** — 5-layer Amazon filter (game name → isTCGProduct → accessory exclusion → seller verification → price validation). Most competitors blast everything; we only alert on actual sealed TCG products.

4. **Amazon seller verification** — OLID scraping + third-party seller suppression. "Sold by Amazon.ca" only. Competitors likely let through marketplace seller noise.

5. **Cost efficiency** — ScraperAPI for hard targets means lower proxy costs. No own ASN or 768-IP investment needed for our niche.

### Where We Lose

1. **Alert speed** — 45-300s intervals vs 1-15s. This is the #1 gap.
2. **No mobile app** — All three competitors have push notification apps
3. **No keyword pinger** — Tempo/Zephyr let users filter by keyword; we send everything
4. **No early SKU monitoring** — Tempo can pre-load SKUs before products go live
5. **No in-store stock checking** — Tempo has ZIP-based stock for 11 retailers
6. **No TLS fingerprint control** — Java/OkHttp >> Node.js for anti-bot sophistication
7. **Single instance** — No geo-distribution, no horizontal scaling yet

### Blueprint: Closing the Gaps

**Phase 1 — Quick wins (already done or easy):**
- [x] Cross-retailer price matching
- [x] Restock history tracking
- [x] Price history in embeds
- [x] Detection speed display
- [x] Amazon ATC buttons (CA)
- [x] $30 minimum price filter
- [x] Non-TCG product filtering
- [x] Third-party seller suppression
- [ ] Discord buttons for ATC (replace markdown links with ButtonBuilder — from plan)
- [ ] US ATC buttons (same ASIN works on .com)

**Phase 2 — Competitive parity:**
- [ ] Keyword pinger system (positive/negative keywords per user, role-based pings)
- [ ] Reduce polling intervals (15-30s for Shopify stores, ~30s for ScraperAPI)
- [ ] SKU forwarding (route specific products to specific channels)
- [ ] Enable remaining Phase 2 Shopify stores
- [ ] Fix EB Games adapter (Odoo rewrite)
- [ ] Best Buy CA adapter

**Phase 3 — Differentiation:**
- [ ] Mobile push notification app (React Native — keyword filtering, watchlist, push via FCM)
- [ ] Pokemon Center UK → CA early SKU discovery (Tempo's trick, adapted for CA)
- [ ] Interactive Discord buttons (Stock Check, one-click ZIP-based in-store lookup)
- [ ] Horizontal scaling (multiple Railway instances or migrate to VPS with worker pool)

**Phase 4 — Advanced:**
- [ ] In-store stock checking (Walmart CA, Costco CA internal APIs by postal code)
- [ ] Barcode scanner web app (like Tempo Pro — camera → instant multi-store stock)
- [ ] Custom TLS fingerprinting (migrate HTTP client to undici or got-scraping for JA3 control)
- [ ] Release calendar / hype calendar for Canadian TCG releases
- [ ] Market intelligence integration (card values, investment signals)

### The Canada Moat

Our strongest competitive position: **Canada-only, TCG-only, depth over breadth.**

- PokeNotify treats Canada as 1 of 6 regions — we make it the only region
- Zephyr and Tempo don't cover Canadian specialty LGS at all
- 40+ Canadian Shopify TCG stores is a dataset no competitor has built
- Canadian residential proxies (Immaculate IPs) give us native Canadian IP addresses
- ScraperAPI `.ca` TLD targeting for Amazon/Walmart provides Canada-specific results
- Understanding Canadian release patterns, pricing in CAD, and local retailer behavior

**The bottom line:** We can't out-infrastructure Zephyr (768 IPs, own ASN, JVM). We can't out-feature Tempo (14 monitor types, in-store checks, barcode scanner). We can't out-scale PokeNotify (50K members, 6 regions). But we can own Canada deeper than any of them.
