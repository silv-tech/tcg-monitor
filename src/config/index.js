require('dotenv').config();
const crypto = require('crypto');

const INSECURE_VALUES = ['changeme', 'test', 'admin', 'password', ''];

const apiKey = process.env.ADMIN_API_KEY || '';
const adminUsername = process.env.ADMIN_USERNAME || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';

// Validate auth config on startup (P0-4)
const hasApiKey = apiKey && !INSECURE_VALUES.includes(apiKey);
const hasCredentials = adminUsername && adminPassword && !INSECURE_VALUES.includes(adminPassword);

if (!hasApiKey && !hasCredentials) {
  console.error('FATAL: Set ADMIN_USERNAME + ADMIN_PASSWORD (or ADMIN_API_KEY) for dashboard auth.');
  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  }
}

module.exports = {
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.DISCORD_GUILD_ID,
    paidChannelId: process.env.PAID_CHANNEL_ID,
    freeChannelId: process.env.FREE_CHANNEL_ID,
    adminChannelId: process.env.ADMIN_CHANNEL_ID,
    paidWebhookUrl: process.env.PAID_WEBHOOK_URL,
    paidRoleId: process.env.PAID_ROLE_ID,
    adminUserId: process.env.ADMIN_USER_ID,
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  admin: {
    port: parseInt(process.env.ADMIN_PORT) || 3500,
    apiKey: apiKey || crypto.randomBytes(16).toString('hex'),
    username: adminUsername,
    password: adminPassword,
  },
  proxy: {
    residentialUrl: process.env.PROXY_RESIDENTIAL_URL,
    residentialUsUrl: process.env.PROXY_RESIDENTIAL_US_URL,
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
