const config = require('../config');
const logger = require('../monitoring/logger');
const { isSystemHealthy, checkRedisHealth, getZeroProductPolls } = require('./health');
const { getBudgetStatus } = require('../utils/scraper-api');
const { EmbedBuilder } = require('discord.js');

// Per-retailer alert dedup — only alert ONCE per stale episode, not every 5 min
const alertedRetailers = new Set(); // retailer IDs we've already alerted for

// Cooldown for budget + redis alerts (these don't have per-item dedup)
let lastBudgetAlert = 0;
let lastRedisAlert = 0;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min cooldown for budget/redis

async function checkAndAlert(discordClient) {
  if (!discordClient || !config.discord.adminChannelId) return;

  const now = Date.now();
  const adminPing = config.discord.adminUserId ? `<@${config.discord.adminUserId}>` : '';

  // --- Retailer health alerts (per-retailer dedup) ---
  const system = await isSystemHealthy();
  const unhealthy = system.retailers.filter(r => !r.healthy);
  const unhealthyIds = new Set(unhealthy.map(r => r.id));

  // Find NEWLY unhealthy retailers (not already alerted)
  const newlyUnhealthy = unhealthy.filter(r => !alertedRetailers.has(r.id));

  // Find RECOVERED retailers (were alerted, now healthy again)
  const recovered = [];
  for (const id of alertedRetailers) {
    if (!unhealthyIds.has(id)) {
      recovered.push(id);
    }
  }

  // Send alert for newly unhealthy retailers
  if (newlyUnhealthy.length > 0) {
    const embed = new EmbedBuilder()
      .setTitle('⚠️ Monitor Alert')
      .setColor(0xff0000)
      .setDescription(`${newlyUnhealthy.length} retailer(s) unhealthy`)
      .setTimestamp();

    for (const r of newlyUnhealthy) {
      const parts = [];
      if (r.consecutiveErrors > 0) parts.push(`Errors: ${r.consecutiveErrors}`);
      if (r.stale) parts.push('⏰ STALE — no check in expected window');
      if (r.zeroProductPolls >= 3) parts.push(`⚠️ 0 products for ${r.zeroProductPolls} polls`);
      if (r.lastError) parts.push(`Last error: ${r.lastError.message}\nat ${new Date(r.lastError.time).toISOString()}`);
      embed.addFields({
        name: r.name,
        value: parts.join('\n') || 'Unknown issue',
        inline: false,
      });

      // Mark as alerted — won't alert again until it recovers
      alertedRetailers.add(r.id);
    }

    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [embed] });
      logger.info(`Sent admin health alert for ${newlyUnhealthy.length} retailer(s): ${newlyUnhealthy.map(r => r.name).join(', ')}`);
    } catch (err) {
      logger.error(`Failed to send admin alert: ${err.message}`);
    }
  }

  // Send recovery alert for retailers that came back
  if (recovered.length > 0) {
    const recoveredNames = recovered.map(id => {
      const r = system.retailers.find(ret => ret.id === id);
      return r ? r.name : id;
    });

    const embed = new EmbedBuilder()
      .setTitle('✅ Monitor Recovery')
      .setColor(0x57f287)
      .setDescription(`${recovered.length} retailer(s) recovered`)
      .setTimestamp();

    for (const name of recoveredNames) {
      embed.addFields({ name, value: 'Back online', inline: true });
    }

    // Clear from alerted set
    for (const id of recovered) {
      alertedRetailers.delete(id);
    }

    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ embeds: [embed] });
      logger.info(`Sent recovery alert: ${recoveredNames.join(', ')}`);
    } catch (err) {
      logger.error(`Failed to send recovery alert: ${err.message}`);
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
