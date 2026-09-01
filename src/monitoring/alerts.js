const config = require('../config');
const logger = require('../monitoring/logger');
const { isSystemHealthy, checkRedisHealth, getZeroProductPolls } = require('./health');
const { getBudgetStatus } = require('../utils/scraper-api');
const { EmbedBuilder } = require('discord.js');

let lastAlertTime = 0;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // Don't spam admin alerts

// Track which alerts we've already sent to avoid repeats
let lastBudgetAlert = 0;
let lastRedisAlert = 0;

async function checkAndAlert(discordClient) {
  if (!discordClient || !config.discord.adminChannelId) return;

  const now = Date.now();
  const adminPing = config.discord.adminUserId ? `<@${config.discord.adminUserId}>` : '';

  // --- Retailer health alerts ---
  const system = await isSystemHealthy();
  if (!system.healthy && now - lastAlertTime >= ALERT_COOLDOWN_MS) {
    lastAlertTime = now;
    const unhealthy = system.retailers.filter(r => !r.healthy);

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Monitor Alert')
      .setColor(0xff0000)
      .setDescription(`${unhealthy.length} retailer(s) unhealthy`)
      .setTimestamp();

    for (const r of unhealthy) {
      const parts = [];
      if (r.consecutiveErrors > 0) parts.push(`Errors: ${r.consecutiveErrors}`);
      if (r.stale) parts.push('⏰ STALE — no check in 5+ min');
      if (r.zeroProductPolls >= 3) parts.push(`⚠️ 0 products for ${r.zeroProductPolls} polls`);
      if (r.lastError) parts.push(`Last error: ${r.lastError.message}\nat ${new Date(r.lastError.time).toISOString()}`);
      embed.addFields({
        name: r.name,
        value: parts.join('\n') || 'Unknown issue',
        inline: false,
      });
    }

    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [embed] });
      logger.info('Sent admin health alert');
    } catch (err) {
      logger.error(`Failed to send admin alert: ${err.message}`);
    }
  }

  // --- ScraperAPI budget alerts (#2) ---
  const budget = getBudgetStatus();
  if (budget.paused && now - lastBudgetAlert >= ALERT_COOLDOWN_MS) {
    lastBudgetAlert = now;
    const budgetEmbed = new EmbedBuilder()
      .setTitle('🚨 ScraperAPI Budget PAUSED')
      .setColor(0xff0000)
      .setDescription(`Credit usage: **${budget.used}/${budget.budget}** (${budget.pct}%)\n\nScraping has been automatically paused to prevent overage. Browser-based fetching still works.`)
      .setTimestamp();
    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [budgetEmbed] });
    } catch (err) {
      logger.error(`Failed to send budget alert: ${err.message}`);
    }
  } else if (budget.warned && !budget.paused && now - lastBudgetAlert >= ALERT_COOLDOWN_MS) {
    lastBudgetAlert = now;
    const warnEmbed = new EmbedBuilder()
      .setTitle('⚠️ ScraperAPI Budget Warning')
      .setColor(0xffa500)
      .setDescription(`Credit usage: **${budget.used}/${budget.budget}** (${budget.pct}%)\n\nApproaching monthly limit. Scraping will auto-pause at 90%.`)
      .setTimestamp();
    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [warnEmbed] });
    } catch (err) {
      logger.error(`Failed to send budget warning: ${err.message}`);
    }
  }

  // --- Redis health alerts (#3) ---
  const redisHealth = await checkRedisHealth();
  if (!redisHealth.healthy && now - lastRedisAlert >= ALERT_COOLDOWN_MS) {
    lastRedisAlert = now;
    const redisEmbed = new EmbedBuilder()
      .setTitle('🚨 Redis Connection Down')
      .setColor(0xff0000)
      .setDescription(`Redis health check failed: ${redisHealth.error || 'unknown'}\n\nState tracking and dedup may be impaired.`)
      .setTimestamp();
    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [redisEmbed] });
    } catch (err) {
      logger.error(`Failed to send Redis alert: ${err.message}`);
    }
  }
}

module.exports = { checkAndAlert };
