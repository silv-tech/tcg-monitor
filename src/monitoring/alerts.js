const config = require('../config');
const logger = require('../monitoring/logger');
const { isSystemHealthy, checkRedisHealth, getZeroProductPolls, getComposition, persistComposition } = require('./health');
const { getBudgetStatus } = require('../utils/scraper-api');
const { EmbedBuilder } = require('discord.js');

// Per-retailer alert state. Alerting ONCE per episode meant a store could sit broken for an
// hour with nothing further said: Costco went DETECTION DOWN at 19:44 and the next word about
// it was silence. So the first alert still fires immediately and is not repeated at that
// cadence, but a store that stays broken is escalated on a widening ladder.
const alertedRetailers = new Map(); // retailerId → { firstAt, lastAt, reminders }

/**
 * Retailers seen unhealthy but not yet paged about — retailerId → when it first went bad.
 *
 * There was NO debounce: the first sweep that saw healthy===false paged immediately. Shopify
 * shops take genuine 429s on /products.json, go quiet while the backoff is honoured, and heal
 * themselves in a couple of minutes; every one of those produced "Monitor Alert / Still down /
 * Recovery" in the client's channel. On 2026-09-09 that was six pages in twenty minutes for
 * outages that had already fixed themselves, which trains everyone to ignore the channel —
 * and an ignored alert channel is a worse failure than the blip it was reporting.
 *
 * A retailer must now still be unhealthy on a later sweep before anyone is told.
 */
const pendingUnhealthy = new Map();
// Three sweeps' worth, on top of the 5-minute stale threshold, so a genuine outage still pages
// at ~11 minutes while a self-healing throttle blip pages not at all.
const PAGE_AFTER_MS = Number(process.env.ALERT_PAGE_AFTER_MS) || 6 * 60 * 1000;
// Reminders at 5, 15 and 30 minutes, then hourly. Widening rather than fixed so a long
// outage does not turn #admin-alerts into a wall of the same message.
const REMINDER_LADDER_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];
const REMINDER_MAX_MS = 60 * 60 * 1000;

function humanDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Symptom lines for one retailer, shared by the first alert and the reminders. */
function describeIssue(r) {
  const parts = [];
  if (r.consecutiveErrors > 0) parts.push(`Errors: ${r.consecutiveErrors}`);
  if (r.stale) parts.push('⏰ STALE — no check in expected window');
  if (r.zeroProductPolls >= 3) parts.push(`⚠️ 0 products for ${r.zeroProductPolls} polls`);
  if (r.servingStaleData) parts.push(`🧊 DETECTION DOWN — only cached data for ${r.zeroFreshPolls} polls`);
  if (r.parserSuspect) parts.push(`🧩 PARSER SUSPECT — only ${Math.round((r.pricedRatio || 0) * 100)}% of products have a price`);
  if (r.lastError) parts.push(`Last error: ${r.lastError.message}`);
  return parts;
}
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

  // Track how long each has been unhealthy, and forget any that healed before we spoke.
  for (const r of unhealthy) if (!pendingUnhealthy.has(r.id)) pendingUnhealthy.set(r.id, now);
  for (const id of [...pendingUnhealthy.keys()]) if (!unhealthyIds.has(id)) pendingUnhealthy.delete(id);

  // Find NEWLY unhealthy retailers: not already alerted, AND still bad after the debounce.
  const newlyUnhealthy = unhealthy.filter(r => !alertedRetailers.has(r.id)
    && now - (pendingUnhealthy.get(r.id) || now) >= PAGE_AFTER_MS);

  // Find RECOVERED retailers (were alerted, now healthy again)
  const recovered = [];
  for (const id of alertedRetailers.keys()) {
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
        // Shared with the still-down reminder, so an outage reads the same way each time.
        const parts = describeIssue(r);
        embed.addFields({
          name: r.name,
          value: (parts.join('\n') || 'Unknown issue').slice(0, 1024),
          inline: false,
        });
      }

      // Mark as alerted — won't alert again until it recovers
      // firstAt is when it BROKE, not when we noticed. It used to be `now`, so every
      // duration in these embeds understated the real silence by the whole debounce plus the
      // stale threshold — which is how "Down for 6 min" and "back online after 2 min" could
      // describe the same episode.
      alertedRetailers.set(r.id, { firstAt: pendingUnhealthy.get(r.id) || now, lastAt: now, reminders: 0 });
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

  // --- Still-down reminders ---
  //
  // A retailer that stays broken gets chased until it recovers. Without this the only
  // notification was the first one, so an outage at 19:44 was still silently ongoing at 20:41.
  const stillDown = unhealthy
    .map(r => ({ r, st: alertedRetailers.get(r.id) }))
    .filter(({ r, st }) => {
      if (!st || newlyUnhealthy.some(n => n.id === r.id)) return false;
      const wait = REMINDER_LADDER_MS[st.reminders] ?? REMINDER_MAX_MS;
      return now - st.lastAt >= wait;
    });

  if (stillDown.length > 0) {
    const embed = new EmbedBuilder()
      .setTitle('⏱️ Still down')
      .setColor(0xe67e22)
      .setDescription(`${stillDown.length} retailer(s) have not recovered.`)
      .setTimestamp();

    for (const { r, st } of stillDown.slice(0, 24)) {
      const down = humanDuration(now - st.firstAt);
      const lines = [`**Down for ${down}**`, ...describeIssue(r)];
      embed.addFields({ name: r.name, value: lines.join(String.fromCharCode(10)).slice(0, 1024), inline: false });
      st.reminders++;
      st.lastAt = now;
    }

    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({ content: adminPing, embeds: [embed] });
      logger.warn(`Sent still-down reminder for ${stillDown.length} retailer(s): ${stillDown.map(x => x.r.name).join(', ')}`);
    } catch (err) {
      logger.error(`Failed to send still-down reminder: ${err.message}`);
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

    for (const id of recovered) {
      const r = system.retailers.find(ret => ret.id === id);
      const st = alertedRetailers.get(id);
      const downFor = st ? ` after ${humanDuration(now - st.firstAt)}` : '';
      embed.addFields({ name: r ? r.name : id, value: `Back online${downFor}`, inline: true });
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
