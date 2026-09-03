const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const config = require('../config');
const logger = require('../monitoring/logger');
const delivery = require('./delivery');
const state = require('../core/state');
const { getStats } = require('../core/proxy');
const { runScan } = require('../core/scan');
const { getBudgetStatus } = require('../utils/scraper-api');

let client;

// Retailer display names
const RETAILER_NAMES = {
  walmart: 'Walmart Canada', amazon: 'Amazon Canada', bestbuy: 'Best Buy Canada',
  costco: 'Costco Canada', pokemoncenter: 'Pokemon Center', ebgames: 'EB Games',
};

async function createBot() {
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('ready', () => {
    logger.info(`Discord bot logged in as ${client.user.tag}`);
    delivery.setClient(client);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Only admin can use commands
    if (interaction.user.id !== config.discord.adminUserId) {
      return interaction.reply({ content: 'Not authorized.', ephemeral: true });
    }

    try {
      switch (interaction.commandName) {
        case 'status': await handleStatus(interaction); break;
        case 'retailers': await handleRetailers(interaction); break;
        case 'test': await handleTest(interaction); break;
        case 'scan': await handleScan(interaction); break;
        case 'test-asin': await handleTestAsin(interaction); break;
        case 'freetier': await handleFreeTier(interaction); break;
        case 'test-sku': await handleTestSku(interaction); break;
        case 'check': await handleCheck(interaction); break;
        case 'watchlist': await handleWatchlist(interaction); break;
        case 'watchlist-add': await handleWatchlistAdd(interaction); break;
        case 'watchlist-remove': await handleWatchlistRemove(interaction); break;
        case 'budget': await handleBudget(interaction); break;
        case 'alerts': await handleAlerts(interaction); break;
        case 'ping': await handlePing(interaction); break;
        case 'help': await handleHelp(interaction); break;
      }
    } catch (err) {
      logger.error(`Command /${interaction.commandName} failed: ${err.message}`);
      const reply = { content: `Command failed: ${err.message}` };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply).catch(() => {});
      } else {
        await interaction.reply({ ...reply, ephemeral: true }).catch(() => {});
      }
    }
  });

  await client.login(config.discord.token);
  await registerCommands();
  return client;
}

// Version bump this when command definitions change (P1-6)
const COMMANDS_VERSION = '7';

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show monitor status and stats'),
    new SlashCommandBuilder()
      .setName('retailers')
      .setDescription('List all retailers and their health'),
    new SlashCommandBuilder()
      .setName('test')
      .setDescription('Send a test alert'),
    new SlashCommandBuilder()
      .setName('scan')
      .setDescription('Resend all cached products to Discord channels')
      .addStringOption(opt =>
        opt.setName('window')
          .setDescription('Time window to scan')
          .setRequired(true)
          .addChoices(
            { name: '12 hours', value: '12' },
            { name: '24 hours', value: '24' },
          )),
    new SlashCommandBuilder()
      .setName('test-asin')
      .setDescription('Send a test alert for a specific Amazon ASIN (with OLID enrichment)')
      .addStringOption(opt =>
        opt.setName('asin')
          .setDescription('Amazon ASIN (e.g. B0GW2DK37Q)')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('freetier')
      .setDescription('Toggle the free tier alerts on or off'),
    new SlashCommandBuilder()
      .setName('test-sku')
      .setDescription('Send a test alert for any retailer SKU (with full enrichment)')
      .addStringOption(opt =>
        opt.setName('retailer')
          .setDescription('Retailer ID (walmart, amazon, bestbuy, costco, pokemoncenter)')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('sku')
          .setDescription('Product SKU or ID')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('check')
      .setDescription('Live stock check — fetch product page and show current status')
      .addStringOption(opt =>
        opt.setName('retailer')
          .setDescription('Retailer ID (walmart, amazon, bestbuy, costco, pokemoncenter)')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('sku')
          .setDescription('Product SKU or ID')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('watchlist')
      .setDescription('Show all watchlist SKUs and their current status'),
    new SlashCommandBuilder()
      .setName('watchlist-add')
      .setDescription('Add a SKU to the fast-poll watchlist')
      .addStringOption(opt =>
        opt.setName('retailer')
          .setDescription('Retailer ID (walmart)')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('sku')
          .setDescription('Product SKU or ID to watch')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('watchlist-remove')
      .setDescription('Remove a SKU from the fast-poll watchlist')
      .addStringOption(opt =>
        opt.setName('retailer')
          .setDescription('Retailer ID (walmart)')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('sku')
          .setDescription('Product SKU or ID to remove')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('budget')
      .setDescription('Show ScraperAPI credit usage and budget status'),
    new SlashCommandBuilder()
      .setName('alerts')
      .setDescription('Show recent alert stats for a retailer')
      .addStringOption(opt =>
        opt.setName('retailer')
          .setDescription('Retailer ID (or "all" for summary)')
          .setRequired(false)),
    new SlashCommandBuilder()
      .setName('ping')
      .setDescription('Check bot latency'),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('List all commands with descriptions'),
  ].map(cmd => cmd.toJSON());

  // Skip re-registration if commands haven't changed (saves Discord API calls)
  const versionKey = 'tcg:commands_version';
  const cached = await state.getRedis().get(versionKey);
  if (cached === COMMANDS_VERSION) {
    logger.info('Slash commands already registered (skipped)');
    return;
  }

  const rest = new REST().setToken(config.discord.token);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
    { body: commands }
  );
  await state.getRedis().set(versionKey, COMMANDS_VERSION);
  logger.info('Slash commands registered');
}

// ─── Command Handlers ────────────────────────────────────────────

async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const proxyStats = getStats();
  const baseRetailers = require('../config/retailers.json');
  const overrides = await state.getRetailerOverrides();
  const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
  const statusLines = [];

  for (const r of retailers) {
    const s = await state.getRetailerStatus(r.id);
    const lastCheck = await state.getLastCheck(r.id);
    const ago = lastCheck ? `${Math.round((Date.now() - lastCheck) / 1000)}s ago` : 'never';
    const health = s.healthy ? '🟢' : '🔴';
    statusLines.push(`${health} **${r.name}** — last check: ${ago}, errors: ${s.errors}`);
  }

  await interaction.editReply({
    content: [
      '**Nocturne Monitors Status**',
      '',
      ...statusLines,
      '',
      `Proxy: ${proxyStats.requests} requests, ${proxyStats.blocked} blocked`,
    ].join('\n'),
  });
}

async function handleRetailers(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const baseRetailers = require('../config/retailers.json');
  const overrides = await state.getRetailerOverrides();
  const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));
  const lines = retailers.map(r =>
    `${r.enabled ? '✅' : '❌'} **${r.name}** — ${r.intervalMs / 1000}s interval, proxy: ${r.proxyTier}`
  );
  await interaction.editReply({ content: lines.join('\n') });
}

async function handleTest(interaction) {
  const testEvent = {
    type: 'RESTOCK',
    product: {
      sku: 'TEST-001',
      name: 'Test Pokemon ETB - Prismatic Evolutions',
      price: 69.99,
      currency: 'CAD',
      url: 'https://example.com',
      image: null,
      retailer: 'Test Retailer',
      inStock: true,
      canAddToCart: true,
      category: 'pokemon',
      productType: 'etb',
      lastSeen: Date.now(),
      shipsToHome: true,
    },
    detail: 'Test alert — system is working!',
  };

  await delivery.deliver([testEvent]);
  await interaction.reply({ content: '✅ Test alert sent!', ephemeral: true });
}

async function handleScan(interaction) {
  const hours = parseInt(interaction.options.getString('window'));
  await interaction.deferReply({ ephemeral: true });

  try {
    const results = await runScan(hours);
    const lines = results.retailers
      .filter(r => r.sent > 0 || r.found > 0)
      .map(r => `${r.sent > 0 ? '🟢' : '⚫'} **${r.name}** — ${r.sent}/${r.found} sent`);

    await interaction.editReply({
      content: [
        `**Scan Complete** (${hours}h window)`,
        '',
        `Total: **${results.totalSent}** products sent to paid channels`,
        '',
        ...lines,
      ].join('\n'),
    });
  } catch (err) {
    await interaction.editReply({ content: `Scan failed: ${err.message}` });
  }
}

async function handleTestAsin(interaction) {
  const asin = interaction.options.getString('asin').trim().toUpperCase();
  await interaction.deferReply({ ephemeral: true });

  const products = await state.getAllProducts('amazon');
  const cached = products[asin];

  const product = cached
    ? { ...cached, retailerId: 'amazon' }
    : {
        sku: asin, name: `Amazon Product ${asin}`, price: 0,
        url: `https://www.amazon.ca/dp/${asin}`, retailer: 'Amazon Canada',
        retailerId: 'amazon', inStock: true, category: 'pokemon', lastSeen: Date.now(),
      };

  const event = {
    type: 'RESTOCK', product,
    detail: `Test alert for ASIN ${asin}`,
    _scanTier: 'scan', _detectedAt: Date.now(),
  };

  await delivery.deliver([event], { skipDedup: true });
  await interaction.editReply({
    content: `✅ Test alert sent for **${asin}**${cached ? ' (from cache)' : ' (manual)'} — check paid channel for OLID!`,
  });
}

async function handleFreeTier(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const channels = await state.getChannelsConfig() || {};
  if (!channels.tiers) channels.tiers = {};
  if (!channels.tiers.free) channels.tiers.free = {};

  const currentlyEnabled = channels.tiers.free.enabled !== false;
  channels.tiers.free.enabled = !currentlyEnabled;

  await state.setChannelsConfig(channels);

  const fs = require('fs');
  const path = require('path');
  const channelsPath = path.join(__dirname, '../config/channels.json');
  const tmp = channelsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(channels, null, 2));
  fs.renameSync(tmp, channelsPath);
  delivery.reloadChannels();

  const newState = !currentlyEnabled ? 'ON' : 'OFF';
  logger.info(`Free tier toggled ${newState} via /freetier command`);
  await interaction.editReply({ content: `Free tier alerts are now **${newState}**` });
}

async function handleTestSku(interaction) {
  const retailerId = interaction.options.getString('retailer').trim().toLowerCase();
  const sku = interaction.options.getString('sku').trim();
  await interaction.deferReply();

  const products = await state.getAllProducts(retailerId);
  const cached = products[sku];

  const product = cached
    ? { ...cached, retailerId }
    : {
        sku, name: `Product ${sku}`, price: 0,
        url: retailerId === 'walmart' ? `https://www.walmart.ca/ip/${sku}` :
             retailerId === 'amazon' ? `https://www.amazon.ca/dp/${sku}` : '',
        retailer: RETAILER_NAMES[retailerId] || retailerId,
        retailerId, inStock: true, canAddToCart: true,
        category: 'pokemon', isTCG: true, lastSeen: Date.now(),
      };

  const event = {
    type: 'RESTOCK', product,
    detail: `Test alert for ${retailerId}:${sku}`,
    _detectedAt: Date.now(), _scanTier: 'scan',
  };

  await delivery.enrichEvent(event);

  const { buildAlertEmbed } = require('./embeds');
  const { embed, components } = buildAlertEmbed(event, 'paid');
  await interaction.editReply({ embeds: [embed], components });

  logger.info(`/test-sku: sent ${retailerId}:${sku} to #${interaction.channel.name} (offerId=${product._offerId || 'none'})`);
}

// ─── NEW: /check — Live stock check ─────────────────────────────

async function handleCheck(interaction) {
  const retailerId = interaction.options.getString('retailer').trim().toLowerCase();
  const sku = interaction.options.getString('sku').trim();
  await interaction.deferReply({ ephemeral: true });

  // Get cached data from Redis
  const cached = await state.getProduct(retailerId, sku);

  // Try live fetch for Walmart
  let live = null;
  const scheduler = require('../core/scheduler');
  const adapter = scheduler.getAdapter(retailerId);

  if (adapter && typeof adapter.fetchProductPage === 'function') {
    try {
      live = await adapter.fetchProductPage(sku);
    } catch (err) {
      logger.debug(`/check live fetch failed for ${retailerId}:${sku}: ${err.message}`);
    }
  }

  const product = live || cached;

  if (!product) {
    await interaction.editReply({ content: `No data found for **${retailerId}:${sku}**. Product may not exist or is not yet cached.` });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(product.inStock ? 0x57f287 : 0xed4245)
    .setTitle(product.name || sku)
    .setTimestamp();

  if (product.url) embed.setURL(product.url);
  if (product.image) embed.setThumbnail(product.image);

  embed.addFields(
    { name: 'Status', value: product.inStock ? '🟢 In Stock' : '🔴 Out of Stock', inline: true },
    { name: 'Price', value: product.price ? `$${product.price.toFixed(2)} CAD` : 'Unknown', inline: true },
    { name: 'Retailer', value: RETAILER_NAMES[retailerId] || retailerId, inline: true },
  );

  if (product.canAddToCart !== undefined) {
    embed.addFields({ name: 'Add to Cart', value: product.canAddToCart ? '✅ Yes' : '❌ No', inline: true });
  }

  if (product._offerId) {
    embed.addFields({ name: 'Offer ID', value: `\`${product._offerId}\``, inline: false });
  }

  if (product.stockCount != null && product.stockCount > 0) {
    embed.addFields({ name: 'Stock Count', value: String(product.stockCount), inline: true });
  }

  // Restock history
  const history = await state.getRestockHistory(retailerId, sku);
  if (history.length > 0) {
    const last = history[history.length - 1];
    const daysAgo = Math.round((Date.now() - last) / 86400000);
    const lastStr = daysAgo === 0 ? 'today' : `${daysAgo}d ago`;
    let historyStr = `Last: ${lastStr}`;
    if (history.length > 1) {
      let totalGap = 0;
      for (let i = 1; i < history.length; i++) totalGap += history[i] - history[i - 1];
      const avgDays = Math.round(totalGap / (history.length - 1) / 86400000);
      historyStr += ` | Avg: every ~${avgDays}d | ${history.length} restocks tracked`;
    }
    embed.addFields({ name: 'Restock History', value: historyStr, inline: false });
  }

  embed.setFooter({ text: `${live ? 'Live fetch' : 'Cached data'} | SKU: ${sku}` });

  await interaction.editReply({ embeds: [embed] });
}

// ─── NEW: /watchlist — Show all watched SKUs ────────────────────

async function handleWatchlist(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const baseRetailers = require('../config/retailers.json');
  const scheduler = require('../core/scheduler');
  const lines = [];

  for (const r of baseRetailers) {
    const adapter = scheduler.getAdapter(r.id);
    if (!adapter || !adapter.watchlist || adapter.watchlist.size === 0) continue;

    const skus = [...adapter.watchlist];
    const skuLines = [];

    for (const sku of skus) {
      const product = await state.getProduct(r.id, sku);
      if (product) {
        const status = product.inStock ? '🟢' : '🔴';
        const price = product.price ? `$${product.price.toFixed(2)}` : '?';
        const seller = product._thirdPartySeller ? ` (3P: ${product._seller || 'unknown'})` : '';
        skuLines.push(`  ${status} \`${sku}\` — ${product.name || 'Unknown'} | ${price}${seller}`);
      } else {
        skuLines.push(`  ⚫ \`${sku}\` — not yet cached`);
      }
    }

    lines.push(`**${r.name}** (${skus.length} SKUs, polling every 5s)`);
    lines.push(...skuLines);
    lines.push('');
  }

  if (lines.length === 0) {
    await interaction.editReply({ content: 'No watchlist SKUs configured for any retailer.' });
    return;
  }

  await interaction.editReply({ content: ['**Watchlist Status**', '', ...lines].join('\n') });
}

// ─── NEW: /watchlist-add — Add SKU to watchlist ─────────────────

async function handleWatchlistAdd(interaction) {
  const retailerId = interaction.options.getString('retailer').trim().toLowerCase();
  const sku = interaction.options.getString('sku').trim();
  await interaction.deferReply({ ephemeral: true });

  const scheduler = require('../core/scheduler');
  const adapter = scheduler.getAdapter(retailerId);

  if (!adapter) {
    await interaction.editReply({ content: `Retailer \`${retailerId}\` not found.` });
    return;
  }

  if (!adapter.watchlist) adapter.watchlist = new Set();

  if (adapter.watchlist.has(sku)) {
    await interaction.editReply({ content: `\`${sku}\` is already in the ${adapter.name} watchlist.` });
    return;
  }

  adapter.watchlist.add(sku);
  scheduler.ensureWatchlistTimer(retailerId);

  // Persist to Redis so it survives deploys
  await state.setWatchlistOverride(retailerId, [...adapter.watchlist]);

  logger.info(`/watchlist-add: added ${sku} to ${retailerId}`);
  await interaction.editReply({ content: `✅ Added \`${sku}\` to **${adapter.name}** watchlist. Polling every 5s.` });
}

// ─── NEW: /watchlist-remove — Remove SKU from watchlist ─────────

async function handleWatchlistRemove(interaction) {
  const retailerId = interaction.options.getString('retailer').trim().toLowerCase();
  const sku = interaction.options.getString('sku').trim();
  await interaction.deferReply({ ephemeral: true });

  const scheduler = require('../core/scheduler');
  const adapter = scheduler.getAdapter(retailerId);

  if (!adapter || !adapter.watchlist) {
    await interaction.editReply({ content: `Retailer \`${retailerId}\` not found or has no watchlist.` });
    return;
  }

  if (!adapter.watchlist.has(sku)) {
    await interaction.editReply({ content: `\`${sku}\` is not in the ${adapter.name} watchlist.` });
    return;
  }

  adapter.watchlist.delete(sku);

  // Persist to Redis so it survives deploys
  await state.setWatchlistOverride(retailerId, [...adapter.watchlist]);

  logger.info(`/watchlist-remove: removed ${sku} from ${retailerId}`);
  await interaction.editReply({ content: `✅ Removed \`${sku}\` from **${adapter.name}** watchlist.` });
}

// ─── NEW: /budget — ScraperAPI credit usage ─────────────────────

async function handleBudget(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const budget = getBudgetStatus();
  const statusIcon = budget.paused ? '🔴 PAUSED' : budget.warned ? '🟡 WARNING' : '🟢 OK';

  const embed = new EmbedBuilder()
    .setColor(budget.paused ? 0xed4245 : budget.warned ? 0xfee75c : 0x57f287)
    .setTitle('ScraperAPI Budget')
    .addFields(
      { name: 'Status', value: statusIcon, inline: true },
      { name: 'Credits Used', value: `${budget.used.toLocaleString()} / ${budget.budget.toLocaleString()}`, inline: true },
      { name: 'Usage', value: `${budget.pct}%`, inline: true },
    )
    .setFooter({ text: 'Budget resets monthly. Persisted across restarts.' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ─── NEW: /alerts — Recent alert stats ──────────────────────────

async function handleAlerts(interaction) {
  const retailerFilter = (interaction.options.getString('retailer') || 'all').trim().toLowerCase();
  await interaction.deferReply({ ephemeral: true });

  const baseRetailers = require('../config/retailers.json');
  const overrides = await state.getRetailerOverrides();
  const retailers = baseRetailers.map(r => ({ ...r, ...(overrides[r.id] || {}) }));

  const lines = [];
  let totalProducts = 0;

  const filtered = retailerFilter === 'all'
    ? retailers.filter(r => r.enabled)
    : retailers.filter(r => r.id === retailerFilter);

  if (filtered.length === 0) {
    await interaction.editReply({ content: `No retailer found matching \`${retailerFilter}\`.` });
    return;
  }

  for (const r of filtered) {
    const products = await state.getAllProducts(r.id);
    const entries = Object.values(products);
    const inStock = entries.filter(p => p.inStock);
    const lastCheck = await state.getLastCheck(r.id);
    const ago = lastCheck ? `${Math.round((Date.now() - lastCheck) / 1000)}s ago` : 'never';
    const status = await state.getRetailerStatus(r.id);

    totalProducts += entries.length;
    lines.push(
      `**${r.name}**`,
      `  Products: ${entries.length} cached, ${inStock.length} in stock`,
      `  Last check: ${ago} | Errors: ${status.errors}`,
      ''
    );
  }

  const header = retailerFilter === 'all'
    ? `**Alert Stats** (${filtered.length} retailers, ${totalProducts} total products)`
    : `**Alert Stats for ${filtered[0].name}**`;

  await interaction.editReply({ content: [header, '', ...lines].join('\n') });
}

// ─── NEW: /ping — Latency check ────────────────────────────────

async function handlePing(interaction) {
  const sent = Date.now();
  await interaction.reply({ content: 'Pinging...', ephemeral: true });
  const latency = Date.now() - sent;
  const wsLatency = client.ws.ping;
  await interaction.editReply({
    content: `🏓 **Pong!**\nBot latency: **${latency}ms**\nWebSocket: **${wsLatency}ms**`,
  });
}

// ─── NEW: /help — Command reference ─────────────────────────────

async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Nocturne Monitors — Commands')
    .setDescription('All available slash commands and what they do.')
    .addFields(
      { name: '🔍 Monitoring', value: [
        '`/status` — Show all retailers health, last check times, error counts',
        '`/retailers` — List all retailers with polling intervals and enabled status',
        '`/check <retailer> <sku>` — Live stock check (fetches product page NOW)',
        '`/alerts [retailer]` — Show product counts and stats per retailer',
      ].join('\n') },
      { name: '🔔 Testing', value: [
        '`/test` — Send a generic test alert to paid channel',
        '`/test-sku <retailer> <sku>` — Send enriched alert in current channel (offerId, history, cross-retailer)',
        '`/test-asin <asin>` — Send Amazon alert with OLID enrichment',
        '`/scan <window>` — Resend all cached products (12h or 24h)',
      ].join('\n') },
      { name: '📋 Watchlist', value: [
        '`/watchlist` — Show all fast-polled SKUs and their status',
        '`/watchlist-add <retailer> <sku>` — Add SKU to 5-second polling',
        '`/watchlist-remove <retailer> <sku>` — Remove SKU from watchlist',
      ].join('\n') },
      { name: '⚙️ System', value: [
        '`/budget` — ScraperAPI credit usage and budget status',
        '`/freetier` — Toggle free tier alerts on/off',
        '`/ping` — Check bot latency',
        '`/help` — This message',
      ].join('\n') },
    )
    .setFooter({ text: 'Nocturne Monitors — All commands are admin-only' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── Post command guide to a channel ────────────────────────────

async function postCommandGuide(channelId) {
  if (!client) return;

  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    logger.error(`Cannot post command guide: channel ${channelId} not found`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Nocturne Monitors — Bot Commands')
    .setDescription('Use these slash commands to monitor, test, and manage the alert system.\nAll commands are restricted to authorized admins.')
    .addFields(
      { name: '──── 🔍 Monitoring ────', value: '\u200B' },
      { name: '/status', value: 'Show all retailers health, last check times, and error counts.', inline: false },
      { name: '/retailers', value: 'List all retailers with polling intervals, proxy tier, and enabled status.', inline: false },
      { name: '/check `retailer` `sku`', value: 'Live stock check. Fetches the product page RIGHT NOW and shows price, stock, seller, offerId.\n**Example:** `/check walmart 66WBIOXIU4UC`', inline: false },
      { name: '/alerts `[retailer]`', value: 'Show product counts, in-stock counts, and last check time per retailer. Use "all" or leave empty for summary.\n**Example:** `/alerts walmart` or `/alerts`', inline: false },

      { name: '──── 🔔 Testing ────', value: '\u200B' },
      { name: '/test', value: 'Send a generic test alert to the paid channel to verify the system is working.', inline: false },
      { name: '/test-sku `retailer` `sku`', value: 'Send a fully enriched alert (offerId, restock history, cross-retailer) directly in the current channel.\n**Example:** `/test-sku walmart 66WBIOXIU4UC`', inline: false },
      { name: '/test-asin `asin`', value: 'Send an Amazon alert with OLID and seller verification.\n**Example:** `/test-asin B0GW2DK37Q`', inline: false },
      { name: '/scan `window`', value: 'Resend ALL cached in-stock products to paid channels. Choose 12h or 24h window.', inline: false },

      { name: '──── 📋 Watchlist ────', value: '\u200B' },
      { name: '/watchlist', value: 'Show all SKUs being fast-polled every 5 seconds with their current stock status, price, and seller.', inline: false },
      { name: '/watchlist-add `retailer` `sku`', value: 'Add a product to the fast-poll watchlist (5-second polling).\n**Example:** `/watchlist-add walmart 6000208831664`', inline: false },
      { name: '/watchlist-remove `retailer` `sku`', value: 'Remove a product from the fast-poll watchlist.\n**Example:** `/watchlist-remove walmart 6000208831664`', inline: false },

      { name: '──── ⚙️ System ────', value: '\u200B' },
      { name: '/budget', value: 'Show ScraperAPI credit usage, monthly budget, and whether scraping is paused.', inline: false },
      { name: '/freetier', value: 'Toggle free tier alerts on or off.', inline: false },
      { name: '/ping', value: 'Check if the bot is responsive and measure latency.', inline: false },
      { name: '/help', value: 'Show a quick reference of all commands (ephemeral — only you see it).', inline: false },
    )
    .setFooter({ text: 'Nocturne Monitors v2 — Commands update automatically on deploy' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  logger.info(`Command guide posted to channel ${channelId}`);
}

function getClient() {
  return client;
}

async function shutdown() {
  if (client) {
    client.destroy();
    client = null;
  }
}

module.exports = { createBot, getClient, shutdown, postCommandGuide };
