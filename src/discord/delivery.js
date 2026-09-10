const fetch = require('node-fetch');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const logger = require('../monitoring/logger');
const { buildAlertEmbed } = require('./embeds');
const imageFetch = require('../utils/image-fetch');

// Hosts whose images Discord's own thumbnail fetcher cannot load, so a remote thumbnail URL
// renders as nothing. For these we download the bytes ourselves and upload them as a Discord
// attachment instead. EB Games' images sit behind a Cloudflare that 403s every datacenter
// fetcher, Discord's included — verified 2026-09-08.
const BLOCKED_IMAGE_HOSTS = new Set(['www.ebgames.ca', 'ebgames.ca']);

function isBlockedImageHost(url) {
  try {
    return BLOCKED_IMAGE_HOSTS.has(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}
const { filterDuplicates, markSent } = require('./dedup');
const alertLimiter = require('./alert-limiter');
const { HIGH_VALUE_TYPES } = require('./alert-limiter');
const { recordAlertLatency } = require('../core/proxy');
const state = require('../core/state');
const { getRestockHistory, findCrossRetailerMatches, getLastCheck, getPriceHistory, getOfferListingId, cacheOfferListingId, getSellerCache, cacheSellerInfo } = state;
const { scrapeAmazonOfferListingId } = require('../utils/browser');
const { fetchAmazonOlidAndSeller } = require('../utils/scraper-api');
const { offersFetcher } = require('../utils/scraper-api');
const { verifyAmazonListing } = require('../utils/amazon-verify');

// Alert types that put a buy link in front of a customer. A wrong identity on any of these
// sends someone to the wrong product; the rest are not worth a credit to verify.
const VERIFY_TYPES = new Set(['RESTOCK', 'NEW_SKU', 'PRICE_CHANGE', 'PREORDER_LIVE']);
// Sized against a measured ~1.2-1.7s for the offers endpoint, inside the sub-5s alert goal.
// A slower response is not worth delaying a drop for — it fails open.
const VERIFY_TIMEOUT_MS = Number(process.env.AMAZON_VERIFY_TIMEOUT_MS || 4000);

const { sleep } = require('../utils/helpers');

// Event priority for delivery ordering (#7) — lower number = higher priority
const EVENT_PRIORITY = {
  RESTOCK: 0,
  PREORDER_LIVE: 1,
  CART_AVAILABLE: 2,
  NEW_SKU: 3,
  PRICE_CHANGE: 4,
  SHIPPING_CHANGE: 5,
  LISTING: 6,
};

let channelsConfig;
try {
  channelsConfig = require('../config/channels.json');
} catch {
  channelsConfig = null;
}

class DeliveryQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.client = null;
    this.channelCache = new Map();
    this.pendingFreeCount = 0;
    this.inFlight = null;       // event currently being sent, for drain() to account for // track in-flight free-tier delays (best-effort, lost on restart)
    // Injectable so the identity gate can be tested without a network call or an API key. The
    // fail-open path is the one that must be provable, and it is unprovable against a live fetch.
    this.verifyListing = (asin) => verifyAmazonListing(asin, { fetcher: offersFetcher, timeoutMs: VERIFY_TIMEOUT_MS });
  }

  setClient(client) {
    this.client = client;
    this.channelCache.clear();
  }

  reloadChannels() {
    delete require.cache[require.resolve('../config/channels.json')];
    channelsConfig = require('../config/channels.json');
    this.channelCache.clear();
    logger.info('Reloaded channel config');
  }

  async deliver(events, { skipDedup } = {}) {
    const toSend = skipDedup ? events : await filterDuplicates(events);
    if (!toSend.length) return;

    for (const event of toSend) {
      // Skip non-TCG products (action figures, plushies, etc.)
      if (!event._scanTier && event.product?.isTCG === false) {
        logger.debug(`Non-TCG product filtered: ${event.product?.name || 'unknown'}`);
        continue;
      }
      // Skip out-of-stock products — ONLY alert on items actually available to buy
      // RESTOCK, PREORDER_LIVE, and EARLY_SKU events are exempt
      if (!event._scanTier && event.product && event.type !== 'RESTOCK' && event.type !== 'PREORDER_LIVE' && event.type !== 'EARLY_SKU') {
        if (!event.product.inStock) {
          logger.debug(`OOS product filtered: ${event.type} — ${event.product?.name || 'unknown'}`);
          continue;
        }
      }
      // Skip products with no price — placeholder/unavailable listings (EARLY_SKU exempt)
      if (!event._scanTier && event.type !== 'EARLY_SKU' && event.product) {
        const price = event.product.price;
        if (price == null || price <= 0) {
          logger.debug(`No-price product filtered: ${event.product?.name || 'unknown'}`);
          continue;
        }
        // Skip low-value products — single packs, blisters, structure decks not worth alerting on
        const MIN_ALERT_PRICE = 15;
        if (price < MIN_ALERT_PRICE) {
          logger.debug(`Low-value product filtered ($${price} < $${MIN_ALERT_PRICE}): ${event.product?.name || 'unknown'}`);
          continue;
        }
      }
      // Skip events disabled by event type toggles (scan events always pass through)
      if (!event._scanTier && channelsConfig?.enabledEvents) {
        if (channelsConfig.enabledEvents[event.type] === false) {
          logger.debug(`Event filtered by toggle: ${event.type} — ${event.product?.name || 'unknown'}`);
          continue;
        }
      }
      // Outbound volume cap — a bad diff must never become a flood in a customer's server
      const verdict = alertLimiter.allow(event);
      if (!verdict.allowed) {
        // A suppressed RESTOCK or PREORDER_LIVE is gone for good — poll-adapter writes the new
        // state right after delivery, so events.js can never re-fire it. Those are logged
        // UNTHROTTLED, with everything needed to check the product by hand afterwards.
        //
        // The throttle below hid exactly this. On 2026-09-09 Amazon was muted and 75 alerts were
        // suppressed; only the 1st and the 50th were ever written down, so which products they
        // were could not be established afterwards even in principle. Losing an alert is bad;
        // losing it without a record is worse, because nobody can tell whether it mattered.
        if (HIGH_VALUE_TYPES.has(event.type)) {
          const p = event.product || {};
          logger.warn(`ALERT LOST (limiter muted ${p.retailerId || 'unknown'}): ${event.type} — `
            + `${p.name || 'unknown'} | sku=${p.sku || '?'} | price=${p.price ?? '?'} | ${p.url || 'no url'}`);
        } else if (verdict.suppressed === 1 || verdict.suppressed % 50 === 0) {
          logger.warn(`Alert suppressed by limiter (${verdict.suppressed} so far): ${event.type} — ${event.product?.name || 'unknown'}`);
        }
        continue;
      }

      if (event.product?._watchlist) {
        // Drop alerts never wait behind the queue — an Amazon enrichment can hold it for 30s
        this.routeEvent(event, Date.now())
          .then(() => (event._scanTier ? null : markSent(event)))
          .catch(err => logger.error('Failed to send watchlist alert', { sku: event.product?.sku, error: err.message }));
        continue;
      }
      this.queue.push({ event, queuedAt: Date.now() });
    }

    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Finish sending whatever is already queued, then resolve.
   *
   * deliver() enqueues and returns without awaiting the send, and shutdown used to stop the
   * scheduler, destroy the Discord client and exit — so anything still in the queue died with
   * the process. Silently: poll-adapter had already written the new product state, so a restock
   * lost this way can never re-fire, and nothing recorded that it happened. Measured queue
   * latency on 2026-09-09 reached 8.5s end to end, and this project deploys on every push.
   *
   * Bounded, because a shutdown that hangs is its own outage: past the deadline we report what
   * is being abandoned rather than blocking the process from exiting.
   */
  async drain(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.processing) && Date.now() < deadline) {
      if (!this.processing && this.queue.length > 0) this.processQueue();
      await sleep(50);
    }
    // The in-flight event has already been shifted out of the queue, so it must be reported
    // separately — otherwise a shutdown landing mid-send loses an alert with no record, which
    // is the exact failure this method exists to close.
    const abandoned = [...(this.inFlight ? [this.inFlight] : []), ...this.queue.map((q) => q.event)];
    for (const event of abandoned) {
      const p = event.product || {};
      logger.error(`ALERT LOST (shutdown before send): ${event.type} — ${p.name || 'unknown'} `
        + `| sku=${p.sku || '?'} | ${p.url || 'no url'}`);
    }
    return abandoned.length;
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Sort by priority (#7): RESTOCK first, LISTING last
      this.queue.sort((a, b) => {
        const pa = EVENT_PRIORITY[a.event.type] ?? 9;
        const pb = EVENT_PRIORITY[b.event.type] ?? 9;
        return pa - pb;
      });
      const { event, queuedAt } = this.queue.shift();
      // Held so drain() can name an alert that was mid-send when the process was told to stop.
      // Without this the in-flight event is invisible: it has already left the queue, so a
      // shutdown during an Amazon enrichment abandoned it with no record at all.
      this.inFlight = event;
      try {
        await this.routeEvent(event, queuedAt);
        // Don't pollute dedup for scan events — organic alerts must still fire
        if (!event._scanTier) {
          await markSent(event);
        }
        // Rate limit: ~20 messages/sec to stay under Discord's limit
        await sleep(50);
      } catch (err) {
        logger.error('Failed to send alert', {
          type: event.type,
          sku: event.product.sku,
          error: err.message,
        });
      } finally {
        this.inFlight = null;
      }
    }

    this.processing = false;
  }

  async enrichEvent(event) {
    const { product } = event;
    if (!product) return;
    try {
      if (product.retailerId && product.sku) {
        event._restockHistory = await getRestockHistory(product.retailerId, product.sku);
        event._priceHistory = await getPriceHistory(product.retailerId, product.sku);
      }
      event._crossRetailer = await findCrossRetailerMatches(product);
      // Freshness: when was this retailer last checked? (#10)
      if (product.retailerId) {
        event._lastCheckedAt = await getLastCheck(product.retailerId);
      }
      // Walmart Offer ID enrichment — free stealth fetch if missing from search results
      if (product.retailerId === 'walmart' && product.sku && !product._offerId) {
        try {
          const { stealthGet } = require('../utils/stealth-http');
          const { getProxyUrl } = require('../core/proxy');
          const proxyUrl = getProxyUrl('residential');
          const html = await stealthGet(`https://www.walmart.ca/ip/${product.sku}?selectedSellerId=0`, {
            proxyUrl,
            maxRetries: 1,
            timeoutMs: 8000,
          });
          if (html && html.length > 500) {
            const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (ndMatch) {
              const nd = JSON.parse(ndMatch[1]);
              const item = nd?.props?.pageProps?.product || nd?.props?.pageProps?.item || nd?.props?.pageProps?.initialData?.data?.product;
              const offerId = item?.offerId || item?.buyBox?.products?.[0]?.offerId;
              if (offerId) {
                product._offerId = offerId;
                logger.info(`Walmart: enriched offerId for ${product.sku}: ${offerId.substring(0, 20)}...`);
              }
            }
          }
        } catch (err) {
          logger.debug(`Walmart offerId enrichment failed for ${product.sku}: ${err.message}`);
        }
      }

      // Amazon Offer Listing ID + seller verification — cache-first, ScraperAPI on miss, Playwright fallback
      if (product.retailerId === 'amazon' && product.sku) {
        const asin = product.sku;
        let olid = await getOfferListingId(asin);
        let seller = await getSellerCache(asin);

        if (!olid || !seller) {
          // Try ScraperAPI first (reliable — handles Amazon anti-bot, 5 credits)
          try {
            const result = await fetchAmazonOlidAndSeller(asin);
            if (result.olid && !olid) {
              olid = result.olid;
              await cacheOfferListingId(asin, olid);
            }
            if (result.seller && !seller) {
              seller = result.seller;
              await cacheSellerInfo(asin, seller);
            }
          } catch (err) {
            logger.debug(`ScraperAPI OLID/seller fetch failed for ${asin}: ${err.message}`);
          }
        }

        if (!olid || !seller) {
          // Fallback: Playwright through residential proxy (less reliable but free)
          try {
            const result = await scrapeAmazonOfferListingId(asin, config.proxy.residentialUrl);
            if (result.olid && !olid) {
              olid = result.olid;
              await cacheOfferListingId(asin, olid);
            }
            if (result.seller && !seller) {
              seller = result.seller;
              await cacheSellerInfo(asin, seller);
            }
          } catch (err) {
            logger.debug(`Playwright OLID/seller fallback failed for ${asin}: ${err.message}`);
          }
        }

        if (olid) event._offerListingId = olid;

        // Seller verification: suppress third-party seller alerts
        if (seller) {
          const sellerLower = seller.toLowerCase();
          const isSoldByAmazon = sellerLower.includes('amazon');
          if (!isSoldByAmazon) {
            event._thirdPartySeller = true;
            event._seller = seller;
            logger.info(`Third-party seller detected for ${asin}: "${seller}"`);
          }
        }
        // If no seller info (scrape failed), fail-open — send the alert anyway
      }

      // ─── Identity: is this still the product we think it is? ───────────────
      //
      // Amazon repurposes ASINs, and our own parser has bound a neighbouring tile's title to the
      // wrong ASIN. Both put a Pokemon name in front of a customer and a different product behind
      // the link: B0D2JGYX3F alerted as a Gardevoir deck and opened a Nex Playground console;
      // B0BCC6N8YL alerted as a booster bundle and opened a PopSockets grip; B0DRDRVZZT alerted as
      // a Gardevoir deck and opened Jamieson Magnesium. All three reached the client's channel.
      //
      // Upstream guards exist — the adapter drops an out-of-scope live title, and a denylist stops
      // re-admission — but each of those runs on a path that can be dead or skipped: the old ones
      // lived inside AOD, and the offers lane only inspects STALE rows, so a row kept fresh by a
      // mis-bound tile is never examined. This is the last check before a send, and it runs on the
      // path that is actually alive.
      //
      // Only the alert types that put a buy link in front of someone are worth a credit. A
      // confirmed mismatch suppresses; anything we could not read fires anyway — see routeEvent.
      if (product.retailerId === 'amazon' && product.sku && !event._scanTier
          && VERIFY_TYPES.has(event.type)) {
        event._identity = await this.verifyListing(product.sku);
      }
    } catch (err) {
      logger.debug(`Event enrichment failed: ${err.message}`);
    }
  }

  async routeEvent(event, queuedAt) {
    await this.enrichEvent(event);

    // FINAL SAFETY: Last-resort OOS guard before any Discord send
    // Catches anything that slipped past the deliver() filter (defense in depth)
    // RESTOCK and PREORDER_LIVE are exempt — they signal availability transitions
    if (!event._scanTier && event.product &&
        event.type !== 'RESTOCK' && event.type !== 'PREORDER_LIVE') {
      if (!event.product.inStock) {
        logger.warn(`OOS guard (routeEvent): blocked ${event.type} — ${event.product?.name || 'unknown'} (inStock=${event.product.inStock})`);
        return;
      }
    }

    // A CONFIRMED wrong identity is the ONE thing worth blocking a send for.
    //
    // Note what is NOT in this condition. The verifier also reports `no-stock` — the right product
    // with nothing buyable — and that must still send. We detect a drop and re-check ~1.5s later,
    // and a hot item can sell out inside that window; treating the re-check as authoritative would
    // suppress precisely the fastest-selling items, and the denylist below would then drop them
    // from tracking permanently, costing every future restock as well. `inconclusive` — a
    // bot-check, a timeout, a budget refusal — fires for the same reason: a suppressed restock is
    // unrecoverable (poll-adapter writes the new state right after delivery, so events.js can never
    // re-fire it), and silence is indistinguishable from success. We never trade a drop for a maybe.
    //
    // Only a wrong identity is permanent, and only a wrong identity is a property of the listing
    // rather than of the moment we happened to look.
    //
    // The ASIN is denylisted on the way out so the row cannot be re-admitted by a stale or
    // mis-bound tile, and the line is logged UNTHROTTLED: a suppression nobody can audit is how we
    // spent an hour unable to say what a mute had eaten.
    if (event._identity && event._identity.verdict === 'wrong-identity' && !event._scanTier) {
      const p = event.product || {};
      logger.warn(`IDENTITY SUPPRESSED: ${event.type} — stored "${p.name}" | live "${event._identity.title}" `
        + `| sku=${p.sku} | ${event._identity.reason}`);
      state.denyIdentity('amazon', p.sku, `alert-time: ${event._identity.reason}`.slice(0, 200))
        .catch((err) => logger.warn(`Could not denylist ${p.sku}: ${err.message}`));
      return;
    }
    if (event._identity && event._identity.verdict === 'no-stock') {
      // Deliberately not a suppression — logged so the RESTOCK race is measurable rather than
      // assumed, and so nobody later mistakes the silence for the gate having done nothing.
      logger.info(`Identity OK, no live offer at re-check (sending anyway): ${event.type} — `
        + `${event.product?.name} | sku=${event.product?.sku}`);
    }

    // Skip Amazon third-party seller products (client wants "sold by Amazon" only)
    // Scan/test events bypass this filter — admin needs to see all alerts
    if (event._thirdPartySeller && !event._scanTier) {
      logger.info(`Suppressed third-party alert: ${event.product?.name} (seller: ${event._seller})`);
      return;
    }

    const { product } = event;
    const category = product.category || 'default';
    const retailerId = product.retailerId || this.retailerIdFromName(product.retailer);

    // --- CATEGORY FILTER: only send alerts for active categories ---
    // Scan/test/watchlist/early events bypass this filter
    // Per-store override takes priority, then falls back to global
    if (!event._scanTier && !product._watchlist && event.type !== 'EARLY_SKU' && !event._earlyKeywordMatch) {
      if (category !== 'default') {
        const storeOverride = await state.getStoreCategories(retailerId);
        const activeCategories = storeOverride || await state.getActiveCategories();
        if (!activeCategories.includes(category)) {
          logger.debug(`Category filter: blocked ${category} alert for ${retailerId} — ${product.name}`);
          return;
        }
      }
    }

    // --- EARLY SKU DETECTION: route to #early-detection channel ---
    if (event.type === 'EARLY_SKU') {
      const earlyChannel = channelsConfig?.earlyDetectionChannel;
      if (earlyChannel) {
        const { embed, components } = buildAlertEmbed(event, 'paid');
        await this.sendToChannel(earlyChannel, embed, components, null, 'paid');
        logger.info(`Early SKU alert sent: ${product.name} (${product.sku})`);
      } else {
        logger.warn('Early SKU event generated but no earlyDetectionChannel configured');
      }
      return;
    }

    // --- EARLY KEYWORD MATCH: also send to #early-detection (continues normal flow too) ---
    if (event._earlyKeywordMatch) {
      const earlyChannel = channelsConfig?.earlyDetectionChannel;
      if (earlyChannel) {
        const { embed, components } = buildAlertEmbed(event, 'paid');
        // Add keyword match info to the embed
        embed.setFooter({ text: `${embed.data.footer?.text || ''} | 🎯 Keyword: "${event._earlyKeywordMatch}"`.trim() });
        await this.sendToChannel(earlyChannel, embed, components, null, 'paid');
        logger.info(`Early keyword alert sent: "${event._earlyKeywordMatch}" → ${product.name} (${product.retailer})`);
      }
      // Don't return — continue normal routing so it also goes to the retailer channel
    }

    // --- SCAN: admin utility, paid channel only, no pings ---
    if (event._scanTier === 'scan') {
      const paidChannel = this.resolvePaidChannel(category, retailerId);
      if (paidChannel) {
        const { embed, components } = buildAlertEmbed(event, 'scan');
        await this.sendToChannel(paidChannel, embed, components, null, 'paid');
      }
      return;
    }

    // --- WATCHLIST: high-priority, send to dedicated channel + admin ---
    if (product._watchlist) {
      const watchCh = channelsConfig?.watchlistChannel;
      const adminCh = channelsConfig?.adminChannel || config.discord.adminChannelId;
      const { embed, components } = buildAlertEmbed(event, 'paid');

      // Watchlist channel (or admin if none) and the retailer channel are sent in parallel
      const targetCh = watchCh || adminCh;
      const paidChannel = this.resolvePaidChannel(category, retailerId);
      const sends = [];
      if (targetCh) {
        sends.push(this.sendToChannel(targetCh, embed, components, '🚨 **WATCHLIST ALERT** 🚨', 'paid'));
      } else {
        logger.error(`WATCHLIST alert generated but no target channel configured! SKU: ${product.sku}, Name: ${product.name}`);
      }
      if (paidChannel && paidChannel !== targetCh) {
        sends.push(this.sendToChannel(paidChannel, embed, components, null, 'paid'));
      }
      await Promise.all(sends);
      if (targetCh) {
        const e2e = event._detectedAt ? Date.now() - event._detectedAt : Date.now() - queuedAt;
        logger.info(`WATCHLIST alert sent in ${e2e}ms: ${event.type} — ${product.name} (${product.sku})`);
      }

      const latency = Date.now() - queuedAt;
      recordAlertLatency(event._detectedAt ? Date.now() - event._detectedAt : latency);
      return; // Skip free tier for watchlist — this is premium intel
    }

    // Build role pings
    const pings = this.buildPings(category, retailerId);

    // --- PAID TIER: send immediately ---
    const paidChannel = this.resolvePaidChannel(category, retailerId);
    if (paidChannel) {
      const { embed, components } = buildAlertEmbed(event, 'paid');
      await this.sendToChannel(paidChannel, embed, components, pings, 'paid');
      const latency = Date.now() - queuedAt;
      const e2eLatency = event._detectedAt ? Date.now() - event._detectedAt : latency;
      recordAlertLatency(e2eLatency);
      logger.info(`Paid alert sent in ${latency}ms (e2e: ${e2eLatency}ms): ${event.type} — ${product.name}`);
    }

    // --- FREE TIER: delayed, limited events, big stores only ---
    if (channelsConfig?.tiers?.free?.enabled === false) return;

    // Free tier only gets high-impact events (no price drops, cart updates, shipping)
    const FREE_EVENTS = new Set(['RESTOCK', 'NEW_SKU', 'PREORDER_LIVE']);
    if (!FREE_EVENTS.has(event.type)) return;

    // Free tier: the big six plus the most active shops. Trimmed when 20 stores were removed —
    // it previously named facetoface, untouchables, pokechalet, catchacard and fusiongaming,
    // which no longer exist.
    const FREE_RETAILERS = new Set([
      'amazon', 'walmart', 'bestbuy', 'costco', 'pokemoncenter', '401games', 'hobbiesville', 'chimeragaming', 'kanzengames', 'deckoutgaming',
    ]);
    if (!FREE_RETAILERS.has(retailerId)) return;

    const freeChannel = this.resolveFreeChannel(category);
    if (freeChannel) {
      const delay = channelsConfig?.tiers?.free?.delay || config.delivery.freeTierDelayMs;
      this.pendingFreeCount++;
      setTimeout(async () => {
        try {
          const { embed, components } = buildAlertEmbed(event, 'free');
          await this.sendToChannel(freeChannel, embed, components, null, 'free');
          logger.info(`Free alert sent (delayed ${delay}ms): ${event.type} — ${product.name}`);
        } catch (err) {
          logger.error(`Failed free tier delivery: ${err.message}`);
        } finally {
          this.pendingFreeCount--;
        }
      }, delay);
    }
  }

  resolvePaidChannel(category, retailerId) {
    if (!channelsConfig) return config.discord.paidChannelId;

    // Priority: retailer-specific channel > category channel > default
    const retailerCh = channelsConfig.retailerChannels?.[retailerId];
    if (retailerCh) return retailerCh;

    const catCh = channelsConfig.tiers?.paid?.channels?.[category];
    if (catCh) return catCh;

    return channelsConfig.tiers?.paid?.channels?.default || config.discord.paidChannelId;
  }

  resolveFreeChannel(category) {
    if (!channelsConfig) return config.discord.freeChannelId;

    const catCh = channelsConfig.tiers?.free?.channels?.[category];
    if (catCh) return catCh;

    return channelsConfig.tiers?.free?.channels?.default || config.discord.freeChannelId;
  }

  buildPings(category, retailerId) {
    if (!channelsConfig?.roles) {
      return config.discord.paidRoleId ? `<@&${config.discord.paidRoleId}>` : null;
    }

    const pings = [];
    const { roles } = channelsConfig;

    // Category role ping (e.g. @Pokemon)
    const catRole = roles.categories?.[category];
    if (catRole) pings.push(`<@&${catRole}>`);

    // Retailer role ping (e.g. @Walmart)
    const retRole = roles.retailers?.[retailerId];
    if (retRole) pings.push(`<@&${retRole}>`);

    // All-alerts role
    if (roles.allAlerts) pings.push(`<@&${roles.allAlerts}>`);

    return pings.length > 0 ? pings.join(' ') : null;
  }

  retailerIdFromName(retailerName) {
    const map = {
      'EB Games': 'ebgames',
      'Best Buy Canada': 'bestbuy',
      'Costco Canada': 'costco',
      'Pokemon Center': 'pokemoncenter',
      'Walmart Canada': 'walmart',
      'Amazon Canada': 'amazon',
    };
    return map[retailerName] || retailerName.toLowerCase().replace(/\s+/g, '');
  }

  /**
   * If the embed's thumbnail points at a host Discord cannot fetch, download the bytes and
   * return a cloned embed whose thumbnail is a local attachment, plus the file to upload.
   * Otherwise returns the embed unchanged with no files. Never throws and never blocks the
   * alert indefinitely — on any failure the original embed is returned (worst case: no image,
   * exactly as before this change).
   */
  async resolveThumbnail(embed) {
    const rawThumb = embed?.data?.thumbnail?.url;
    if (!rawThumb || !isBlockedImageHost(rawThumb)) return { embed, files: undefined };
    const bytes = await imageFetch.fetchImageBytes(rawThumb, { retailerId: 'ebgames' });
    if (!bytes) return { embed, files: undefined };
    const name = 'thumb.jpg';
    // Clone so a shared embed (e.g. watchlist sent to two channels) is never mutated in place —
    // each message gets its own attachment reference.
    const clone = EmbedBuilder.from(embed.data).setThumbnail(`attachment://${name}`);
    return { embed: clone, files: [new AttachmentBuilder(bytes, { name })] };
  }

  async sendToChannel(channelId, embed, components, content, tier) {
    if (!channelId) {
      logger.error('Alert dropped: no channel ID provided');
      return;
    }

    // Try bot first
    if (this.client) {
      try {
        const channel = await this.fetchChannel(channelId);
        if (channel) {
          // For hosts Discord cannot fetch (EB Games), swap the remote thumbnail for a
          // locally-uploaded attachment. Returns the original embed untouched otherwise.
          const { embed: outEmbed, files } = await this.resolveThumbnail(embed);
          const payload = { embeds: [outEmbed] };
          if (files) payload.files = files;
          if (content) payload.content = content;
          if (components && components.length) payload.components = components;
          await channel.send(payload);
          return;
        }
        logger.warn(`Bot cannot access channel ${channelId} — channel not found or missing permissions`);
      } catch (err) {
        logger.warn(`Bot send failed for ${channelId}: ${err.message}, trying webhook fallback`);
      }
    }

    // Webhook fallback — includes components (#13)
    const webhookUrl = this.resolveWebhook(tier);
    if (webhookUrl) {
      await this.sendWebhook(webhookUrl, embed, content, components);
      return;
    }

    // BOTH paths failed — alert is lost
    logger.error(`ALERT DROPPED: Could not deliver to channel ${channelId} — bot send failed and no webhook configured for ${tier} tier`);
  }

  async fetchChannel(channelId) {
    if (this.channelCache.has(channelId)) return this.channelCache.get(channelId);
    try {
      const channel = await this.client.channels.fetch(channelId);
      this.channelCache.set(channelId, channel);
      return channel;
    } catch (err) {
      logger.warn(`Channel fetch failed for ${channelId}: ${err.message}`);
      return null;
    }
  }

  resolveWebhook(tier) {
    if (tier === 'paid' && config.discord.paidWebhookUrl) return config.discord.paidWebhookUrl;
    if (!channelsConfig?.webhooks) return null;
    return channelsConfig.webhooks[`${tier}_default`] || null;
  }

  async sendWebhook(url, embed, content, components, retries = 0) {
    const body = { embeds: [embed.toJSON()] };
    if (content) body.content = content;
    // Include button components in webhook payload (#13)
    if (components && components.length) {
      body.components = components.map(c => c.toJSON());
    }

    // P2-10: 10-second timeout via AbortController
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // P2-7: Retry on Discord 429 rate limit (up to 2 retries)
      if (res.status === 429 && retries < 2) {
        const retryAfter = parseFloat(res.headers.get('retry-after') || '2') * 1000;
        logger.warn(`Webhook rate limited, retrying in ${retryAfter}ms`);
        await sleep(Math.min(retryAfter, 10000));
        return this.sendWebhook(url, embed, content, components, retries + 1);
      }

      if (!res.ok) {
        throw new Error(`Webhook failed: ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = new DeliveryQueue();
