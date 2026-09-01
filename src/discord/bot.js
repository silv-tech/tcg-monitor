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
    }
  });

  await client.login(config.discord.token);
  await registerCommands();
  return client;
}

// Version bump this when command definitions change (P1-6)
const COMMANDS_VERSION = '2';

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
      '**Pulse Watch Status**',
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
