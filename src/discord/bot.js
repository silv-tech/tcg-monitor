const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const config = require('../config');
const logger = require('../monitoring/logger');
const delivery = require('./delivery');
const state = require('../core/state');
const { getStats } = require('../core/proxy');

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
    }
  });

  await client.login(config.discord.token);
  await registerCommands();
  return client;
}

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
  ].map(cmd => cmd.toJSON());

  const rest = new REST().setToken(config.discord.token);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, config.discord.guildId),
    { body: commands }
  );
  logger.info('Slash commands registered');
}

async function handleStatus(interaction) {
  const proxyStats = getStats();
  const retailers = require('../config/retailers.json');
  const statusLines = [];

  for (const r of retailers) {
    const s = await state.getRetailerStatus(r.id);
    const lastCheck = await state.getLastCheck(r.id);
    const ago = lastCheck ? `${Math.round((Date.now() - lastCheck) / 1000)}s ago` : 'never';
    const health = s.healthy ? '🟢' : '🔴';
    statusLines.push(`${health} **${r.name}** — last check: ${ago}, errors: ${s.errors}`);
  }

  await interaction.reply({
    content: [
      '**TCG Monitor Status**',
      '',
      ...statusLines,
      '',
      `📊 Proxy: ${proxyStats.requests} requests, ${proxyStats.blocked} blocked`,
    ].join('\n'),
    ephemeral: true,
  });
}

async function handleRetailers(interaction) {
  const retailers = require('../config/retailers.json');
  const lines = retailers.map(r =>
    `${r.enabled ? '✅' : '❌'} **${r.name}** — ${r.intervalMs / 1000}s interval, proxy: ${r.proxyTier}`
  );
  await interaction.reply({ content: lines.join('\n'), ephemeral: true });
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
