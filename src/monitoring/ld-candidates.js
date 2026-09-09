/**
 * Surface in-store-only London Drugs product that has landed on shelves.
 *
 * These go to the ADMIN channel, never to the client channel.
 *
 * A hidden London Drugs code carries no name through any endpoint — /details, /summary, /price,
 * /seo, /images, /media, /fulfillment and ?includeHidden=true were all checked, and the product
 * page 404s. All we get is a code, per-store stock, and box art. And "hidden" does not imply
 * Pokemon: one scan window on 2026-09-09 turned up a NETGEAR ProSafe switch and a bag of Peeps
 * marshmallows alongside three genuine 30th Celebration SKUs.
 *
 * The stock screen removes those two comfortably (they held 1 and 13 units; the real drops held
 * 2,628 to 3,696), but seven samples is not enough to put an unnamed product in front of paying
 * members on the strength of a threshold. So a person identifies it from the image first. That
 * costs one look and removes the only failure mode that would embarrass the client.
 */

const config = require('../config');
const logger = require('./logger');
const { EmbedBuilder } = require('discord.js');

const QUEUE_KEY = 'tcg:ld:candidates';
// Bounded per sweep: a backlog must never stall the health check that runs alongside it.
const MAX_PER_SWEEP = 5;

async function reportLdCandidates(discordClient) {
  if (!discordClient || !config.discord.adminChannelId) return 0;

  // Required lazily: importing core/state opens a Redis connection, and alerts.js is imported
  // by tests that never touch Redis — an eager require left those processes hanging open.
  let redis;
  try { redis = require('../core/state').getRedis(); } catch { redis = null; }
  if (!redis || typeof redis.lpop !== 'function') return 0;

  let sent = 0;

  for (let i = 0; i < MAX_PER_SWEEP; i++) {
    let raw;
    try { raw = await redis.lpop(QUEUE_KEY); } catch { return sent; }
    if (!raw) return sent;

    let c;
    try { c = JSON.parse(raw); } catch { continue; }   // a corrupt entry is dropped, not retried
    if (!c || !c.code) continue;

    const lines = (c.top || [])
      .map((t) => `• ${t.name || `store ${t.code}`} — ${t.qty}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('London Drugs — new IN-STORE product')
      .setColor(0x0b5fa5)
      .setDescription(
        `**${c.code}** is stocked in stores but is **not listed on londondrugs.com**, `
        + 'so there is no name to read.\nIdentify it from the image below, then add it to the '
        + 'watchlist if it is TCG.',
      )
      .addFields(
        { name: 'Stock', value: `${c.units} units across ${c.stores} store(s)`, inline: true },
        { name: 'Code', value: String(c.code), inline: true },
        ...(lines ? [{ name: 'Top stores', value: lines }] : []),
      )
      .setTimestamp();

    if (c.image) embed.setImage(c.image);

    try {
      const channel = await discordClient.channels.fetch(config.discord.adminChannelId);
      await channel.send({
        content: config.discord.adminUserId ? `<@${config.discord.adminUserId}>` : '',
        embeds: [embed],
      });
      sent++;
      logger.info(`London Drugs in-store candidate reported: ${c.code} — ${c.units} units / ${c.stores} store(s)`);
    } catch (err) {
      // Leave the remainder queued rather than dropping drops on a transient Discord failure.
      logger.error(`Failed to report London Drugs candidate ${c.code}: ${err.message}`);
      return sent;
    }
  }

  return sent;
}

module.exports = { reportLdCandidates, QUEUE_KEY, MAX_PER_SWEEP };
