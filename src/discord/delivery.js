const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../monitoring/logger');
const { buildAlertEmbed } = require('./embeds');
const { filterDuplicates, markSent } = require('./dedup');
const { recordAlertLatency } = require('../core/proxy');
const { sleep } = require('../utils/helpers');

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
    this.pendingFreeCount = 0; // track in-flight free-tier delays (best-effort, lost on restart)
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
      // Skip events disabled by event type toggles (scan events always pass through)
      if (!event._scanTier && channelsConfig?.enabledEvents) {
        if (channelsConfig.enabledEvents[event.type] === false) {
          logger.debug(`Event filtered by toggle: ${event.type} — ${event.product?.name || 'unknown'}`);
          continue;
        }
      }
      this.queue.push({ event, queuedAt: Date.now() });
    }

    if (!this.processing) {
      this.processQueue();
    }
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const { event, queuedAt } = this.queue.shift();
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
      }
    }

    this.processing = false;
  }

  async routeEvent(event, queuedAt) {
    const { product } = event;
    const category = product.category || 'default';
    const retailerId = product.retailerId || this.retailerIdFromName(product.retailer);

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

      // Send to watchlist channel (or admin if no watchlist channel set)
      const targetCh = watchCh || adminCh;
      if (targetCh) {
        await this.sendToChannel(targetCh, embed, components, '🚨 **WATCHLIST ALERT** 🚨', 'paid');
        logger.info(`WATCHLIST alert sent: ${event.type} — ${product.name} (${product.sku})`);
      } else {
        logger.error(`WATCHLIST alert generated but no target channel configured! SKU: ${product.sku}, Name: ${product.name}`);
      }

      // Also send to paid channel as normal
      const paidChannel = this.resolvePaidChannel(category, retailerId);
      if (paidChannel && paidChannel !== targetCh) {
        await this.sendToChannel(paidChannel, embed, components, null, 'paid');
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

    // --- FREE TIER: send after delay (best-effort — lost on restart, paid tier already delivered) ---
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

  async sendToChannel(channelId, embed, components, content, tier) {
    if (!channelId) return;

    // Try bot first
    if (this.client) {
      try {
        const channel = await this.fetchChannel(channelId);
        if (channel) {
          const payload = { embeds: [embed] };
          if (content) payload.content = content;
          if (components && components.length) payload.components = components;
          await channel.send(payload);
          return;
        }
      } catch (err) {
        logger.warn(`Bot send failed for ${channelId}: ${err.message}, trying webhook fallback`);
      }
    }

    // Webhook fallback
    const webhookUrl = this.resolveWebhook(tier);
    if (webhookUrl) {
      await this.sendWebhook(webhookUrl, embed, content);
    }
  }

  async fetchChannel(channelId) {
    if (this.channelCache.has(channelId)) return this.channelCache.get(channelId);
    try {
      const channel = await this.client.channels.fetch(channelId);
      this.channelCache.set(channelId, channel);
      return channel;
    } catch {
      return null;
    }
  }

  resolveWebhook(tier) {
    if (!channelsConfig?.webhooks) return null;
    return channelsConfig.webhooks[`${tier}_default`] || null;
  }

  async sendWebhook(url, embed, content) {
    const body = { embeds: [embed.toJSON()] };
    if (content) body.content = content;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Webhook failed: ${res.status}`);
    }
  }
}

module.exports = new DeliveryQueue();
