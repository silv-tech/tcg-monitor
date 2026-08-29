require('dotenv').config();

module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID,
    paidChannelId: process.env.PAID_CHANNEL_ID,
    freeChannelId: process.env.FREE_CHANNEL_ID,
    adminChannelId: process.env.ADMIN_CHANNEL_ID,
    paidRoleId: process.env.PAID_ROLE_ID,
    adminUserId: process.env.ADMIN_USER_ID,
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  admin: {
    port: parseInt(process.env.ADMIN_PORT) || 3500,
    apiKey: process.env.ADMIN_API_KEY || 'changeme',
  },
  proxy: {
    residentialUrl: process.env.PROXY_RESIDENTIAL_URL,
    datacenterUrl: process.env.PROXY_DATACENTER_URL,
  },
  delivery: {
    freeTierDelayMs: parseInt(process.env.FREE_TIER_DELAY_MS) || 45000,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  nodeEnv: process.env.NODE_ENV || 'development',
};
