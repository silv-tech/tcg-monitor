const config = require('../config');
const logger = require('../monitoring/logger');
const { isSystemHealthy, checkRedisHealth, getZeroProductPolls, getComposition, persistComposition } = require('./health');
const { getBudgetStatus } = require('../utils/scraper-api');
const { EmbedBuilder } = require('discord.js');

// Per-retailer alert dedup — only alert ONCE per stale episode, not every 5 min
const alertedRetailers = new Set();
const alertedComposition = new Set(); // retailerId:games signature already reported

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

    // Discord embeds take at most 25 fields — a mass outage lists the first 24 and counts the rest
    const MAX_LISTED = 24;
    newlyUnhealthy.forEach((r, i) => {
      if (i < MAX_LISTED) {
        const parts = [];
        if (r.consecutiveErrors > 0) parts.push(`Errors: ${r.consecutiveErrors}`);
        if (r.stale) parts.push('⏰ STALE — no check in expected window');
        if (r.zeroProductPolls >= 3) parts.push(`⚠️ 0 products for ${r.zeroProductPolls} polls`);
        if (r.servingStaleData) parts.push(`🧊 DETECTION DOWN — only cached data for ${r.zeroFreshPolls} polls`);
        if (r.parserSuspect) parts.push(`🧩 PARSER SUSPECT — only ${Math.round((r.pricedRatio || 0) * 100)}% of products have a price`);
        if (r.lastError) parts.push(`Last error: ${r.lastError.message}\nat ${new Date(r.lastError.time).toISOString()}`);
        embed.addFields({
          name: r.name,
          value: (parts.join('\n') || 'Unknown issue').slice(0, 1024),
          inline: false,
        });
      }

      // Mark as alerted — won't alert again until it recovers
      alertedRetailers.add(r.id);
    });
    if (newlyUnhealthy.length > MAX_LISTED) {
      embed.addFields({ name: 'More', value: `…and ${newlyUnhealthy.length - MAX_LISTED} more retailers`, inline: false });
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

  // --- Composition alerts: a whole game quietly vanished from a store ---
  //
  // Deliberately its own path, because a store losing a category is NOT unhealthy in the
  // usual sense: it polls fine, prices fine, errors zero. The 'hat ' bug that classified
  // One Piece as clothing produced exactly that — every check green, drops silently missed.
  // A missed drop never raises an error, so this is the only thing that would say so.
  const lostByRetailer = getComposition();
  const newlyLost = Object.entries(lostByRetailer).filter(([id, games]) => {
    const key = id + ':' + games.map(g => g.game).sort().join(',');
    if (alertedComposition.has(key)) return false;
    alertedComposition.add(key);
    return true;
  });

  if (newlyLost.length > 0) {
    const embed = new EmbedBuilder()
      .setTitle('🔍 Category missing from a store')
      .setColor(0xf0b232)
      .setDescription(
        'A store has stopped tracking a game it used to carry. This does not show up as an ' +
        'error — polls still succeed — so it is worth checking whether the store stopped ' +
        'stocking it, or whether a scope or parser change is dropping it.'
      )
      .setTimestamp();

    for (const [id, games] of newlyLost.slice(0, 24)) {
      const r = system.retailers.find(ret => ret.id === id);
      embed.addFields({
        name: r ? r.name : id,
        value: games
          .map(g => `**${g.game}** — zero for ${g.missingPolls} polls (normally ~${g.typical} products)`)
          .join(String.fromCharCode(10))
          .slice(0, 1024),
        inline: false,
      });
    }

    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [embed] });
      logger.info(`Sent composition alert for ${newlyLost.length} retailer(s)`);
    } catch (err) {
      logger.error(`Failed to send composition alert: ${err.message}`);
    }
  }

  // Clear the dedup key once a store carries its category again, so a repeat is reported.
  for (const key of [...alertedComposition]) {
    const id = key.split(':')[0];
    const still = lostByRetailer[id];
    const sig = still ? id + ':' + still.map(g => g.game).sort().join(',') : null;
    if (sig !== key) alertedComposition.delete(key);
  }

  await persistComposition();

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

/**
 * One-off admin notice, for conditions that surface between health sweeps —
 * currently the alert limiter tripping on a retailer.
 */
async function sendAdminNotice(discordClient, { title, description, color = 0xff0000 }) {
  if (!discordClient || !config.discord.adminChannelId) return;
  const adminPing = config.discord.adminUserId ? `<@${config.discord.adminUserId}>` : '';
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription(description)
    .setTimestamp();
  try {
    const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
    await channel.send({ content: adminPing, embeds: [embed] });
  } catch (err) {
    logger.error(`Failed to send admin notice "${title}": ${err.message}`);
  }
}

module.exports = { checkAndAlert, sendAdminNotice };
