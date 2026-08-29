const config = require('../config');
const logger = require('../monitoring/logger');
const { isSystemHealthy } = require('./health');
const { EmbedBuilder } = require('discord.js');

let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // Don't spam admin alerts

async function checkAndAlert(discordClient) {
  if (!discordClient || !config.discord.adminChannelId) return;

  const system = await isSystemHealthy();
  if (system.healthy) return;

  const now = Date.now();
  if (now - lastAlertTime < ALERT_COOLDOWN_MS) return;
  lastAlertTime = now;

  const unhealthy = system.retailers.filter(r => !r.healthy);

  const embed = new EmbedBuilder()
    .setTitle('⚠️ Monitor Alert')
    .setColor(0xff0000)
    .setDescription(`${unhealthy.length} retailer(s) unhealthy`)
    .setTimestamp();

  for (const r of unhealthy) {
    const errorInfo = r.lastError
      ? `\nLast error: ${r.lastError.message}\nat ${new Date(r.lastError.time).toISOString()}`
      : '';
    embed.addFields({
      name: r.name,
      value: `Errors: ${r.consecutiveErrors}${r.stale ? '\n⏰ STALE — no check in 5+ min' : ''}${errorInfo}`,
      inline: false,
    });
  }

  const adminPing = config.discord.adminUserId ? `<@${config.discord.adminUserId}>` : '';

  try {
    const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
    await channel.send({ content: adminPing, embeds: [embed] });
    logger.info('Sent admin health alert');
  } catch (err) {
    logger.error(`Failed to send admin alert: ${err.message}`);
  }
}

module.exports = { checkAndAlert };
