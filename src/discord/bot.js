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
        case 'early-add': await handleEarlyAdd(interaction); break;
        case 'early-remove': await handleEarlyRemove(interaction); break;
        case 'early-list': await handleEarlyList(interaction); break;
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
const COMMANDS_VERSION = '8';

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
    new SlashCommandBuilder()
      .setName('early-add')
      .setDescription('Add a keyword to early detection (alerts when any retailer lists a matching product)')
      .addStringOption(opt =>
        opt.setName('keyword')
          .setDescription('Keyword or phrase to watch for (e.g. "destined rivals elite trainer")')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('early-remove')
      .setDescription('Remove a keyword from early detection')
      .addStringOption(opt =>
        opt.setName('keyword')
          .setDescription('Keyword to remove')
          .setRequired(true)),
    new SlashCommandBuilder()
      .setName('early-list')
      .setDescription('Show all early detection keywords'),
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

  // Load from Redis, fallback to channels.json file
  const fs = require('fs');
  const path = require('path');
  const channelsPath = path.join(__dirname, '../config/channels.json');
  let channels = await state.getChannelsConfig();
  if (!channels) {
    try { channels = JSON.parse(fs.readFileSync(channelsPath, 'utf-8')); } catch { channels = {}; }
  }
  if (!channels.tiers) channels.tiers = {};
  if (!channels.tiers.free) channels.tiers.free = {};

  const currentlyEnabled = channels.tiers.free.enabled !== false;
  channels.tiers.free.enabled = !currentlyEnabled;

  await state.setChannelsConfig(channels);

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
    .setColor(0x2b2d31)
    .setTitle('Nocturne Monitors')
    .setDescription('Quick command reference — **18 commands** available.')
    .addFields(
      {
        name: '📡  Monitoring',
        value: [
          '`/status` — Health dashboard',
          '`/retailers` — All retailers & config',
          '`/check` `retailer` `sku` — Live lookup',
          '`/alerts` `[retailer]` — Product stats',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🧪  Testing',
        value: [
          '`/test` — Test alert',
          '`/test-sku` `retailer` `sku` — Full preview',
          '`/test-asin` `asin` — Amazon OLID',
          '`/scan` `window` — Bulk resend',
        ].join('\n'),
        inline: true,
      },
      { name: '\u200B', value: '\u200B', inline: false },
      {
        name: '📋  Watchlist',
        value: [
          '`/watchlist` — View watched SKUs',
          '`/watchlist-add` `retailer` `sku` — 5s polling',
          '`/watchlist-remove` `retailer` `sku` — Remove',
        ].join('\n'),
        inline: true,
      },
      {
        name: '🎯  Early Detection',
        value: [
          '`/early-add` `keyword` — Watch globally',
          '`/early-remove` `keyword` — Remove',
          '`/early-list` — View active keywords',
        ].join('\n'),
        inline: true,
      },
      { name: '\u200B', value: '\u200B', inline: false },
      {
        name: '⚙️  System',
        value: [
          '`/budget` — ScraperAPI credits & budget',
          '`/freetier` — Toggle free tier on/off',
          '`/ping` — Bot latency',
          '`/help` — This message',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Nocturne Monitors  ·  Admin Only' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ─── NEW: /early-add — Add keyword to early detection ───────────

async function handleEarlyAdd(interaction) {
  const keyword = interaction.options.getString('keyword').trim();
  await interaction.deferReply({ ephemeral: true });

  if (keyword.length < 3) {
    await interaction.editReply({ content: 'Keyword must be at least 3 characters.' });
    return;
  }

  if (keyword.length > 100) {
    await interaction.editReply({ content: 'Keyword must be under 100 characters.' });
    return;
  }

  const added = await state.addEarlyKeyword(keyword);
  if (!added) {
    await interaction.editReply({ content: `\`${keyword}\` is already in the early detection list.` });
    return;
  }

  const all = await state.getEarlyKeywords();
  // Get early detection channel for display
  const fs = require('fs');
  const path = require('path');
  let chConfig;
  try { chConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/channels.json'), 'utf-8')); } catch { chConfig = {}; }
  const earlyChId = chConfig.earlyDetectionChannel || 'early-detection';

  logger.info(`/early-add: added "${keyword}" (${all.length} total keywords)`);
  await interaction.editReply({ content: `✅ Added **"${keyword}"** to early detection.\n\nWhen any retailer lists a product matching this keyword, you'll get a priority alert in <#${earlyChId}>.\n\n**${all.length}** keyword(s) active.` });
}

// ─── NEW: /early-remove — Remove keyword from early detection ───

async function handleEarlyRemove(interaction) {
  const keyword = interaction.options.getString('keyword').trim();
  await interaction.deferReply({ ephemeral: true });

  const removed = await state.removeEarlyKeyword(keyword);
  if (!removed) {
    await interaction.editReply({ content: `\`${keyword}\` was not found in the early detection list.` });
    return;
  }

  const all = await state.getEarlyKeywords();
  logger.info(`/early-remove: removed "${keyword}" (${all.length} remaining)`);
  await interaction.editReply({ content: `✅ Removed **"${keyword}"** from early detection.\n\n**${all.length}** keyword(s) remaining.` });
}

// ─── NEW: /early-list — Show all early detection keywords ───────

async function handleEarlyList(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const keywords = await state.getEarlyKeywords();

  if (keywords.length === 0) {
    await interaction.editReply({ content: 'No early detection keywords set.\n\nUse `/early-add` to add keywords like "destined rivals" or "prismatic evolutions etb".' });
    return;
  }

  const lines = keywords.map((kw, i) => `${i + 1}. \`${kw}\``);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('Early Detection Keywords')
    .setDescription(lines.join('\n'))
    .addFields({
      name: 'How it works',
      value: 'When any of the 37 retailers lists a new product or restocks a product matching one of these keywords, a priority alert is sent to the early detection channel — on top of the normal alert.',
    })
    .setFooter({ text: `${keywords.length} keyword(s) active` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ─── Post command guide to a channel ────────────────────────────

async function postCommandGuide(channelId) {
  if (!client) return;

  const channel = await client.channels.fetch(channelId);
  if (!channel) {
    logger.error(`Cannot post command guide: channel ${channelId} not found`);
    return;
  }

  const header = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setThumbnail(client.user.displayAvatarURL({ size: 128 }))
    .setDescription([
      '# NOCTURNE MONITORS',
      '-# Command Reference Guide',
      '',
      'Real-time TCG stock alerts across **37 Canadian retailers** with millisecond-speed detection, early keyword matching, and cross-retailer intelligence.',
      '',
      '> All commands are **admin-only** and respond ephemerally (only visible to you).',
    ].join('\n'));

  const commands = new EmbedBuilder()
    .setColor(0x2b2d31)
    .addFields(
      {
        name: '📡  MONITORING',
        value: [
          '**`/status`**',
          'System health dashboard — retailer statuses, last check times, consecutive errors, and proxy stats.',
          '',
          '**`/retailers`**',
          'Full retailer list with polling intervals, proxy tiers, and enabled/disabled state.',
          '',
          '**`/check`** `<retailer>` `<sku>`',
          'Live stock check — fetches the product page in real-time. Returns price, stock status, add-to-cart, Offer ID, and restock history.',
          '-# Example:  `/check walmart 66WBIOXIU4UC`',
          '',
          '**`/alerts`** `[retailer]`',
          'Product counts, in-stock totals, and timing data per retailer. Leave empty for full summary.',
          '-# Example:  `/alerts walmart`  ·  `/alerts`',
        ].join('\n'),
      },
      {
        name: '🧪  TESTING & ALERTS',
        value: [
          '**`/test`**',
          'Sends a sample alert to paid channels to verify the pipeline is working.',
          '',
          '**`/test-sku`** `<retailer>` `<sku>`',
          'Fully enriched alert preview — Offer ID, restock history, cross-retailer matches.',
          '-# Example:  `/test-sku walmart 66WBIOXIU4UC`',
          '',
          '**`/test-asin`** `<asin>`',
          'Amazon alert with OLID enrichment and seller verification.',
          '-# Example:  `/test-asin B0GW2DK37Q`',
          '',
          '**`/scan`** `<window>`',
          'Resend all cached in-stock products to paid channels. Choose **12h** or **24h** window.',
        ].join('\n'),
      },
      {
        name: '📋  WATCHLIST',
        value: [
          '**`/watchlist`**',
          'View all fast-polled SKUs with current stock status, price, and seller info.',
          '',
          '**`/watchlist-add`** `<retailer>` `<sku>`',
          'Add a product to the priority queue — polled every **5 seconds** for instant detection.',
          '-# Example:  `/watchlist-add walmart 6000208831664`',
          '',
          '**`/watchlist-remove`** `<retailer>` `<sku>`',
          'Remove a product from the fast-poll queue.',
          '',
          '-# Watchlist changes persist across restarts via Redis.',
        ].join('\n'),
      },
      {
        name: '🎯  EARLY DETECTION',
        value: [
          '**`/early-add`** `<keyword>`',
          'Monitor a keyword across **all 37 retailers**. When a product matching the keyword is listed or restocked, a priority alert fires in the early detection channel — on top of normal routing.',
          '-# Example:  `/early-add prismatic evolutions elite trainer`',
          '',
          '**`/early-remove`** `<keyword>`',
          'Remove a keyword from the active detection list.',
          '-# Example:  `/early-remove prismatic evolutions elite trainer`',
          '',
          '**`/early-list`**',
          'View all active keywords being monitored.',
          '',
          '-# Runs on every poll cycle + sitemap scan. Matches are dual-routed.',
        ].join('\n'),
      },
      {
        name: '⚙️  SYSTEM',
        value: [
          '**`/budget`** — ScraperAPI credit usage, monthly budget, and pause status.',
          '**`/freetier`** — Toggle free tier delayed alerts on or off.',
          '**`/ping`** — Bot and WebSocket response latency.',
          '**`/help`** — Compact command reference (ephemeral).',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Nocturne Monitors  ·  18 Commands  ·  Admin Only  ·  v2' })
    .setTimestamp();

  await channel.send({ embeds: [header, commands] });
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
