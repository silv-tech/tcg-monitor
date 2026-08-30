# TCG Monitor

Real-time stock monitoring system for Canadian TCG (Trading Card Game) retailers. Watches for restocks, new products, price changes, and pre-orders, then pushes alerts to Discord with tiered access (paid/free).

## Quick Start

```bash
# 1. Copy env file and fill in values
cp .env.example .env

# 2. Start with Docker (recommended)
docker-compose up -d

# 3. Or run locally (requires Redis)
npm install
npm start
```

## Architecture

```
src/
├── index.js              # Entry point — scheduler + Discord bot + admin server
├── config/
│   ├── index.js           # Env vars and defaults
│   ├── retailers.json     # All retailer configs (30+ stores)
│   ├── products.json      # Keywords, categories, tracked SKUs
│   └── channels.json      # Discord channel routing + role pings
├── core/
│   ├── scheduler.js       # Poll loop with staggered starts
│   ├── state.js           # Redis state tracking (per-SKU)
│   ├── events.js          # Diff old vs new → emit events
│   └── proxy.js           # Proxy rotation + cost/latency metrics
├── adapters/
│   ├── base.js            # Base class (fetch, stealthFetch, classify)
│   ├── shopify.js         # Universal Shopify adapter (28 stores)
│   ├── bestbuy.js         # Best Buy Canada (open API)
│   ├── walmart.js         # Walmart Canada (stealth required)
│   ├── amazon.js          # Amazon Canada (residential proxy needed)
│   ├── costco.js          # Costco Canada (sitemap + JSON-LD)
│   ├── pokemoncenter.js   # Pokemon Center (Incapsula protected)
│   ├── ebgames.js         # EB Games (currently disabled — site rebuild)
│   └── _template.js       # Template for adding new retailers
├── discord/
│   ├── bot.js             # Discord.js v14 bot + slash commands
│   ├── embeds.js          # Rich embeds with retailer branding
│   ├── delivery.js        # Tiered delivery, channel routing, webhooks
│   └── dedup.js           # Redis-backed alert deduplication
├── admin/
│   ├── server.js          # Express admin API
│   └── routes.js          # CRUD for retailers, SKUs, keywords, channels
├── monitoring/
│   ├── health.js          # Health checks (stale data detection)
│   ├── alerts.js          # Admin Discord alerts on failures
│   └── logger.js          # Winston structured logging
└── utils/
    ├── http.js            # HTTP client with retry + proxy support
    ├── stealth-http.js    # got-scraping TLS fingerprint randomization
    ├── cookies.js         # Cookie jar management
    └── helpers.js         # Classification, pricing, utilities
```

## Event Types

| Event | Trigger |
|-------|---------|
| `RESTOCK` | Out of stock → In stock |
| `NEW_SKU` | Product never seen before |
| `PRICE_CHANGE` | Price differs from last check |
| `PREORDER_LIVE` | Pre-order becomes available |
| `CART_AVAILABLE` | Add-to-cart becomes available |
| `SHIPPING_CHANGE` | Fulfillment option changed |

## Retailers

### Working Now (no proxy needed)
- **Shopify stores** (28 stores) — 401 Games, Face to Face, Hobbiesville, PokeChalet, Catcha Card, SP Shop, Remi Card Trader, Card Cycle, Vancity CJ, Infinity Cards, Poke Therapy, Shopville, Tista Minis, Does Cards, ZardoCards, Rival Cards, Hasty Cards, Emmetts ToyStop, TonkaTom TCG, Vancity TCG, Deck Out Gaming, Danireon Cards, Poke Jeux, TCGfy, Hobby Stop TCG, Card Legends TCG, GameShack, Fusion Gaming
- **Best Buy Canada** — Open search + availability API
- **Costco Canada** — Sitemap discovery + product page JSON-LD

### Need Residential Proxy
- **Walmart Canada** — Works intermittently with stealth TLS, consistent with residential proxy
- **Amazon Canada** — Akamai Bot Manager, needs residential proxy
- **Pokemon Center** — Imperva Incapsula, needs residential proxy or headless browser

### Disabled
- **EB Games** — Site in maintenance (Odoo rebuild)
- **Indigo/Chapters** — Doesn't sell TCG products

## Discord Delivery

Tiered delivery system:
- **Paid tier**: Instant alerts with role pings, per-retailer and per-game channel routing
- **Free tier**: Configurable delay (default 45 seconds), separate channels

Channel routing is configured in `src/config/channels.json`:
```json
{
  "tiers": {
    "paid": { "channels": { "pokemon": "CHANNEL_ID", "default": "CHANNEL_ID" } },
    "free": { "channels": { "default": "CHANNEL_ID" }, "delay": 45000 }
  },
  "retailerChannels": { "walmart": "CHANNEL_ID" },
  "roles": {
    "categories": { "pokemon": "ROLE_ID" },
    "retailers": { "walmart": "ROLE_ID" },
    "allAlerts": "ROLE_ID"
  }
}
```

## Admin Dashboard

Web dashboard at `http://localhost:3500`:
- System overview (uptime, requests, latency, proxy cost)
- Enable/disable retailers
- Manage tracked keywords and SKUs
- Per-retailer performance metrics
- Channel configuration viewer

API key set via `ADMIN_API_KEY` env var.

## Adding a New Shopify Store

1. Test the store: `curl https://storename.com/products.json?limit=1`
2. If it returns products, add to `src/config/retailers.json`:
```json
{
  "id": "storename",
  "name": "Store Name",
  "url": "https://storename.com",
  "adapter": "shopify",
  "intervalMs": 60000,
  "proxyTier": "none",
  "enabled": true,
  "color": "#333333"
}
```
3. Restart the monitor.

## Adding a New Custom Retailer

1. Copy `src/adapters/_template.js` to `src/adapters/newretailer.js`
2. Implement `fetchProducts()` — return `{ [sku]: product }` map
3. Use `this.classify()` to auto-categorize products
4. Register in `src/index.js` ADAPTER_MAP
5. Add config entry in `retailers.json`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `DISCORD_GUILD_ID` | Yes | Discord server ID |
| `REDIS_URL` | Yes | Redis connection URL |
| `ADMIN_API_KEY` | Yes | Admin dashboard API key |
| `PAID_CHANNEL_ID` | Yes | Default paid alerts channel |
| `FREE_CHANNEL_ID` | Yes | Default free alerts channel |
| `ADMIN_CHANNEL_ID` | No | Admin alerts channel |
| `ADMIN_USER_ID` | No | Admin user for DM alerts |
| `PAID_ROLE_ID` | No | Role to ping on paid alerts |
| `PROXY_RESIDENTIAL_URL` | No | Residential proxy URL |
| `PROXY_DATACENTER_URL` | No | Datacenter proxy URL |
| `FREE_TIER_DELAY_MS` | No | Free tier delay (default 45000) |
| `LOG_LEVEL` | No | Log level (default "info") |

## Testing

```bash
npm test
```

39 tests covering event detection, product classification, embed building, and high-volume simulation (500 SKUs).

## Deployment (Railway)

1. Push to GitHub
2. Create Railway project with Redis add-on
3. Set environment variables
4. Deploy — Docker auto-detected

## Tech Stack

- **Runtime**: Node.js 20+
- **State**: Redis (ioredis)
- **Bot**: Discord.js v14
- **HTTP**: node-fetch + got-scraping (TLS fingerprinting)
- **Parsing**: cheerio (HTML), built-in JSON
- **Admin**: Express + static HTML dashboard
- **Logging**: Winston
- **Deploy**: Docker + docker-compose
