const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const config = require('../config');
const logger = require('../monitoring/logger');
const delivery = require('./delivery');
const state = require('../core/state');
const { getStats } = require('../core/proxy');
const { runScan } = require('../core/scan');

let client;

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

    switch (interaction.commandName) {
      case 'status':
        await handleStatus(interaction);
        break;
      case 'retailers':
        await handleRetailers(interaction);
        break;
      case 'test':
        await handleTest(interaction);
        break;
      case 'scan':
        await handleScan(interaction);
        break;
      case 'test-asin':
        await handleTestAsin(interaction);
        break;
      case 'freetier':
        await handleFreeTier(interaction);
        break;
      case 'test-sku':
        await handleTestSku(interaction);
        break;
    }
  });

  await client.login(config.discord.token);
  await registerCommands();
  return client;
}

// Version bump this when command definitions change (P1-6)
const COMMANDS_VERSION = '5';

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
          .setDescription('Retailer ID (walmart, amazon, bestbuy, costco, pokemoncenter, shopify store)')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('sku')
          .setDescription('Product SKU or ID')
          .setRequired(true)),
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

async function handleStatus(interaction) {
  await interaction.deferReply({ ephemeral: true }); // P1-7: prevent timeout with many retailers

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
      `📊 Proxy: ${proxyStats.requests} requests, ${proxyStats.blocked} blocked`,
    ].join('\n'),
  });
}

async function handleRetailers(interaction) {
  await interaction.deferReply({ ephemeral: true }); // P1-7: prevent timeout with many retailers

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

  try {
    // Try to find this ASIN in the cached Amazon products
    const products = await state.getAllProducts('amazon');
    const cached = products[asin];

    const product = cached
      ? { ...cached, retailerId: 'amazon' }
      : {
          sku: asin,
          name: `Amazon Product ${asin}`,
          price: 0,
          url: `https://www.amazon.ca/dp/${asin}`,
          retailer: 'Amazon Canada',
          retailerId: 'amazon',
          inStock: true,
          category: 'pokemon',
          lastSeen: Date.now(),
        };

    const event = {
      type: 'RESTOCK',
      product,
      detail: `Test alert for ASIN ${asin} — enrichment pipeline active`,
      _scanTier: 'scan', // Use scan tier so it goes to paid channel only, no dedup
      _detectedAt: Date.now(),
    };

    await delivery.deliver([event], { skipDedup: true });
    await interaction.editReply({
      content: `✅ Test alert sent for **${asin}**${cached ? ' (from cache)' : ' (manual)'} — check paid channel for OLID!`,
    });
  } catch (err) {
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleFreeTier(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const channels = await state.getChannelsConfig() || {};
    if (!channels.tiers) channels.tiers = {};
    if (!channels.tiers.free) channels.tiers.free = {};

    const currentlyEnabled = channels.tiers.free.enabled !== false;
    channels.tiers.free.enabled = !currentlyEnabled;

    await state.setChannelsConfig(channels);

    // Write to disk + reload delivery module
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
  } catch (err) {
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
}

async function handleTestSku(interaction) {
  const retailerId = interaction.options.getString('retailer').trim().toLowerCase();
  const sku = interaction.options.getString('sku').trim();
  await interaction.deferReply();

  try {
    // Try to find product in Redis cache
    const products = await state.getAllProducts(retailerId);
    const cached = products[sku];

    const retailerNames = {
      walmart: 'Walmart Canada', amazon: 'Amazon Canada', bestbuy: 'Best Buy Canada',
      costco: 'Costco Canada', pokemoncenter: 'Pokemon Center', ebgames: 'EB Games',
    };

    const product = cached
      ? { ...cached, retailerId }
      : {
          sku,
          name: `Product ${sku}`,
          price: 0,
          url: retailerId === 'walmart' ? `https://www.walmart.ca/ip/${sku}` :
               retailerId === 'amazon' ? `https://www.amazon.ca/dp/${sku}` : '',
          retailer: retailerNames[retailerId] || retailerId,
          retailerId,
          inStock: true,
          canAddToCart: true,
          category: 'pokemon',
          isTCG: true,
          lastSeen: Date.now(),
        };

    const event = {
      type: 'RESTOCK',
      product,
      detail: `Test alert for ${retailerId}:${sku}`,
      _detectedAt: Date.now(),
      _scanTier: 'scan',
    };

    // Enrich (offerId, restock history, cross-retailer, etc.)
    await delivery.enrichEvent(event);

    // Send directly to THIS channel
    const { buildAlertEmbed } = require('./embeds');
    const { embed, components } = buildAlertEmbed(event, 'paid');
    await interaction.editReply({ embeds: [embed], components });

    logger.info(`/test-sku: sent ${retailerId}:${sku} to #${interaction.channel.name} (offerId=${product._offerId || 'none'})`);
  } catch (err) {
    await interaction.editReply({ content: `Failed: ${err.message}` });
  }
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

module.exports = { createBot, getClient, shutdown };
