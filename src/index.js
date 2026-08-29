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

const ADAPTER_MAP = {
  ebgames: EBGamesAdapter,
  costco: CostcoAdapter,
  pokemoncenter: PokemonCenterAdapter,
  walmart: WalmartAdapter,
  amazon: AmazonAdapter,
};

async function main() {
  logger.info('TCG Monitor starting...');

  // 1. Start Discord bot
  if (config.discord.token) {
    await createBot();
    logger.info('Discord bot online');
  } else {
    logger.warn('No DISCORD_TOKEN — running without Discord');
  }

  // 2. Register adapters from config
  const retailers = require('./config/retailers.json');
  for (const retailer of retailers) {
    const AdapterClass = ADAPTER_MAP[retailer.adapter];
    if (!AdapterClass) {
      logger.warn(`Unknown adapter: ${retailer.adapter}`);
      continue;
    }
    scheduler.register(new AdapterClass(retailer));
  }

  // 3. Wire events to delivery
  scheduler.setEventHandler(async (events) => {
    await delivery.deliver(events);
  });

  // 4. Start scheduler
  await scheduler.start();

  // 5. Start admin server
  const adminServer = createAdminServer();

  // 6. Health check loop — every 2 minutes
  const healthInterval = setInterval(async () => {
    const client = getClient();
    if (client) await checkAndAlert(client);
  }, 2 * 60 * 1000);

  // Graceful shutdown
  async function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down...`);
    clearInterval(healthInterval);
    scheduler.stop();
    adminServer.close();
    await shutdownBot();
    await shutdownState();
    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info('TCG Monitor running');
}

main().catch((err) => {
  logger.error('Fatal startup error', { error: err.message, stack: err.stack });
  process.exit(1);
});
