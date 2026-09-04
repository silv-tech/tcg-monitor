const config = require('./config');
const logger = require('./monitoring/logger');
const scheduler = require('./core/scheduler');
const delivery = require('./discord/delivery');
const { createBot, getClient, shutdown: shutdownBot } = require('./discord/bot');
const { createAdminServer } = require('./admin/server');
const { checkAndAlert } = require('./monitoring/alerts');
const { shutdown: shutdownState } = require('./core/state');

// Adapter imports
const EBGamesAdapter = require('./adapters/ebgames');
const CostcoAdapter = require('./adapters/costco');
const PokemonCenterAdapter = require('./adapters/pokemoncenter');
const WalmartAdapter = require('./adapters/walmart');
const AmazonAdapter = require('./adapters/amazon');
const ShopifyAdapter = require('./adapters/shopify');
const BestBuyAdapter = require('./adapters/bestbuy');
const { scanSitemaps, SCAN_INTERVAL_MS } = require('./core/sitemap-scanner');
let closeBrowser;
try { closeBrowser = require('./utils/browser').closeBrowser; } catch { closeBrowser = null; }

const ADAPTER_MAP = {
  ebgames: EBGamesAdapter,
  costco: CostcoAdapter,
  pokemoncenter: PokemonCenterAdapter,
  walmart: WalmartAdapter,
  amazon: AmazonAdapter,
  shopify: ShopifyAdapter,
  bestbuy: BestBuyAdapter,
};

async function main() {
  logger.info('Nocturne Monitors starting...');

  // 1. Start Discord bot
  if (config.discord.token) {
    await createBot();
    logger.info('Discord bot online');
  } else {
    logger.warn('No DISCORD_TOKEN — running without Discord');
  }

  // 2. Seed config files from Redis (survives ephemeral filesystem deploys)
  const stateModule = require('./core/state');
  const fs = require('fs');
  const path = require('path');

  // P2-8: Atomic writes — write to temp then rename
  function atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  }

  const savedChannels = await stateModule.getChannelsConfig();
  if (savedChannels) {
    atomicWrite(path.join(__dirname, 'config/channels.json'), JSON.stringify(savedChannels, null, 2));
    delivery.reloadChannels();
    logger.info('Seeded channels.json from Redis');
  }

  const savedProducts = await stateModule.getProductsConfig();
  if (savedProducts) {
    atomicWrite(path.join(__dirname, 'config/products.json'), JSON.stringify(savedProducts, null, 2));
    logger.info('Seeded products.json from Redis');
  }

  // 2b. Verify bot can access configured retailer channels
  if (config.discord.token) {
    const client = getClient();
    if (client) {
      let channelsConfig;
      try { channelsConfig = require('./config/channels.json'); } catch { channelsConfig = null; }
      const retailerChannels = channelsConfig?.retailerChannels || {};
      const entries = Object.entries(retailerChannels).filter(([, id]) => id);

      if (entries.length > 0) {
        const results = await Promise.all(entries.map(async ([retailerId, channelId]) => {
          try {
            await client.channels.fetch(channelId);
            return true;
          } catch (err) {
            logger.error(`CHANNEL ACCESS DENIED: ${retailerId} → ${channelId} (${err.message}). Alerts for this retailer will be DROPPED.`);
            return false;
          }
        }));
        const accessible = results.filter(Boolean).length;
        const failed = results.length - accessible;
        logger.info(`Channel verification: ${accessible}/${entries.length} retailer channels accessible${failed > 0 ? `, ${failed} FAILED` : ''}`);
      }

      // Also check default channels
      const paidDefault = channelsConfig?.tiers?.paid?.channels?.default;
      const freeDefault = channelsConfig?.tiers?.free?.channels?.default;
      if (paidDefault) {
        try { await client.channels.fetch(paidDefault); }
        catch { logger.error(`DEFAULT PAID channel ${paidDefault} not accessible — alerts may be lost!`); }
      }
      if (freeDefault) {
        try { await client.channels.fetch(freeDefault); }
        catch { logger.error(`DEFAULT FREE channel ${freeDefault} not accessible — alerts may be lost!`); }
      }
    }
  }

  // 2c. Verify residential proxies if configured
  const { testProxy } = require('./core/proxy');
  if (config.proxy.residentialUrl) {
    await testProxy(config.proxy.residentialUrl, 'Residential CA proxy');
  }
  if (config.proxy.residentialUsUrl) {
    await testProxy(config.proxy.residentialUsUrl, 'Residential US proxy');
  }

  // 3. Register adapters from config (merge Redis overrides so enabled/interval state persists)
  const baseRetailers = require('./config/retailers.json');
  const overrides = await stateModule.getRetailerOverrides();
  const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));

  // Redis overrides silently win over retailers.json, so the file on disk can disagree with
  // what is actually running. Say so at boot rather than letting the next reader be misled.
  const drift = [];
  for (const base of baseRetailers) {
    const ov = overrides[base.id];
    if (!ov) continue;
    for (const [k, v] of Object.entries(ov)) {
      if (JSON.stringify(base[k]) !== JSON.stringify(v)) drift.push(`${base.id}.${k}: file=${JSON.stringify(base[k])} live=${JSON.stringify(v)}`);
    }
  }
  if (drift.length > 0) {
    logger.warn(`Config drift — ${drift.length} value(s) overridden in Redis, retailers.json is NOT the source of truth:`);
    for (const d of drift) logger.warn(`  ${d}`);
  }
  const live = retailers.filter(r => r.enabled);
  logger.info(`Effective config: ${live.length}/${retailers.length} retailers enabled — ${live.map(r => `${r.id}@${Math.round(r.intervalMs / 1000)}s`).join(', ')}`);
  for (const retailer of retailers) {
    const AdapterClass = ADAPTER_MAP[retailer.adapter];
    if (!AdapterClass) {
      logger.warn(`Unknown adapter: ${retailer.adapter}`);
      continue;
    }
    scheduler.register(new AdapterClass(retailer));
  }

  // 4. Wire events to delivery
  scheduler.setEventHandler(async (events) => {
    await delivery.deliver(events);
  });

  // 4b. Tell the admin when a retailer's alert volume trips the limiter — a flood is
  // usually a parser or cache-state bug, and it is the customer-visible kind.
  {
    const alertLimiter = require('./discord/alert-limiter');
    const { sendAdminNotice } = require('./monitoring/alerts');
    alertLimiter.setTripHandler((retailerId, reason) => {
      const client = getClient();
      sendAdminNotice(client, {
        title: '🔇 Alert flood suppressed',
        description: `**${retailerId}** exceeded its alert rate limit and is muted for 10 minutes.\n\n${reason}\n\nAlerts from other retailers are unaffected. This usually means a parser change or stale cached state — check the diff before unmuting.`,
      }).catch(() => {});
    });
  }

  // 5. Start scheduler
  await scheduler.start();
  stateModule.startCrossRetailerIndexRefresh();

  // 5b. Start Early SKU Detection (Walmart sitemap scanner)
  let sitemapTimer = null;
  async function runSitemapScan() {
    try {
      const events = await scanSitemaps();
      if (events.length > 0) {
        logger.info(`Early SKU: Sending ${events.length} events to #early-detection`);
        await delivery.deliver(events, { skipDedup: true });
      }
    } catch (err) {
      logger.error(`Early SKU scan failed: ${err.message}`);
    }
  }

  // Run first scan after 30s (let adapters warm up first), then every 12h
  let sitemapStartup = setTimeout(async () => {
    sitemapStartup = null;
    await runSitemapScan();
    sitemapTimer = setInterval(runSitemapScan, SCAN_INTERVAL_MS);
    logger.info(`Early SKU Detection: scheduled every ${SCAN_INTERVAL_MS / 3600000}h`);
  }, 30000);

  // 6. Start admin server
  const adminServer = createAdminServer();

  // 7. One-time sample alerts — show client the system is live
  // Sends one real product from Pokemon Center, Best Buy, and Costco after first polls complete
  const stateForSample = require('./core/state');
  setTimeout(async () => {
    try {
      const sampleFlag = await stateForSample.getRedis().get('tcg:sample_alerts_sent');
      if (sampleFlag) {
        logger.info('Sample alerts already sent (skipping)');
        return;
      }

      const sampleRetailers = ['pokemoncenter', 'bestbuy', 'costco'];
      const sampleEvents = [];

      for (const retailerId of sampleRetailers) {
        const products = await stateForSample.getAllProducts(retailerId);
        const entries = Object.values(products);
        if (entries.length === 0) continue;

        // Pick first product with a name
        const sample = entries.find(p => p.name && p.isTCG !== false) || entries[0];
        if (!sample) continue;

        sampleEvents.push({
          type: 'LISTING',
          product: { ...sample, retailerId, lastSeen: Date.now() },
          detail: `Now monitoring ${entries.length} products at ${sample.retailer || retailerId}`,
          _scanTier: 'paid', // bypass TCG filter and dedup
        });
      }

      if (sampleEvents.length > 0) {
        await delivery.deliver(sampleEvents, { skipDedup: true });
        await stateForSample.getRedis().set('tcg:sample_alerts_sent', '1', 'EX', 86400 * 30); // don't re-send for 30 days
        logger.info(`Sent ${sampleEvents.length} sample alerts (Pokemon Center, Best Buy, Costco)`);
      }
    } catch (err) {
      logger.error(`Sample alerts failed: ${err.message}`);
    }
  }, 3 * 60 * 1000); // Wait 3 minutes for first polls to complete

  // 8. Health check loop — every 2 minutes
  const healthInterval = setInterval(async () => {
    const client = getClient();
    if (client) await checkAndAlert(client);
  }, 2 * 60 * 1000);

  // Graceful shutdown
  async function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(healthInterval);
    if (sitemapStartup) clearTimeout(sitemapStartup);
    if (sitemapTimer) clearInterval(sitemapTimer);
    scheduler.stop();
    adminServer.close();
    await shutdownBot();
    if (closeBrowser) await closeBrowser();
    await shutdownState();
    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('Nocturne Monitors running');
}

// P2-1: Prevent unhandled errors from crashing the entire process
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason?.message || String(reason), stack: reason?.stack });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', { error: err.message, stack: err.stack });
  process.exit(1);
});

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
