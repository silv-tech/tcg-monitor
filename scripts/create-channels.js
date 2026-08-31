const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
require('dotenv').config();
const retailers = require('../src/config/retailers.json');
const fs = require('fs');
const path = require('path');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
  if (!guild) { console.log('Guild not found'); process.exit(1); }

  const enabled = retailers.filter(r => r.enabled);

  // Split into big box and shopify
  const bigBox = enabled.filter(r => !['shopify'].includes(r.adapter));
  const shopify = enabled.filter(r => r.adapter === 'shopify');

  // Create category channels
  console.log('Creating category: Big Box Retailers...');
  const bigBoxCategory = await guild.channels.create({
    name: 'Big Box Retailers',
    type: ChannelType.GuildCategory,
  });

  console.log('Creating category: Card Shops...');
  const shopifyCategory = await guild.channels.create({
    name: 'Card Shops',
    type: ChannelType.GuildCategory,
  });

  const channelMap = {};

  // Create big box channels
  for (const r of bigBox) {
    const channelName = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    try {
      const ch = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: bigBoxCategory.id,
        topic: `${r.name} stock alerts — polling every ${r.intervalMs / 1000}s`,
      });
      channelMap[r.id] = ch.id;
      console.log(`  #${channelName} → ${ch.id}`);
    } catch (err) {
      console.log(`  FAILED: ${channelName} — ${err.message}`);
    }
  }

  // Create shopify channels
  for (const r of shopify) {
    const channelName = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    try {
      const ch = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: shopifyCategory.id,
        topic: `${r.name} stock alerts — polling every ${r.intervalMs / 1000}s`,
      });
      channelMap[r.id] = ch.id;
      console.log(`  #${channelName} → ${ch.id}`);
    } catch (err) {
      console.log(`  FAILED: ${channelName} — ${err.message}`);
    }
  }

  // Update channels.json
  const channelsPath = path.join(__dirname, '..', 'src', 'config', 'channels.json');
  const channelsConfig = JSON.parse(fs.readFileSync(channelsPath, 'utf8'));
  channelsConfig.retailerChannels = channelMap;
  fs.writeFileSync(channelsPath, JSON.stringify(channelsConfig, null, 2) + '\n');
  console.log('\nchannels.json updated with', Object.keys(channelMap).length, 'retailer channels');

  client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
