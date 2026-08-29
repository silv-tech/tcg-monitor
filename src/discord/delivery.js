const config = require('../config');
const logger = require('../monitoring/logger');
const { buildEmbed } = require('./embeds');
const { filterDuplicates, markSent } = require('./dedup');
const { sleep } = require('../utils/helpers');

class DeliveryQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  async deliver(events) {
    const unique = await filterDuplicates(events);
    if (!unique.length) return;

    for (const event of unique) {
      this.queue.push(event);
    }

    if (!this.processing) {
      this.processQueue();
    }
  }

  async processQueue() {
    if (!this.client || this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const event = this.queue.shift();
      try {
        await this.sendEvent(event);
        await markSent(event);
        // Rate limit: ~20 messages/sec to stay well under Discord's limit
        await sleep(50);
      } catch (err) {
        logger.error('Failed to send alert', {
          type: event.type,
          sku: event.product.sku,
          error: err.message,
        });
      }
    }

    this.processing = false;
  }

  async sendEvent(event) {
    const embed = buildEmbed(event);
    const { paidChannelId, freeChannelId, paidRoleId } = config.discord;

    // Send to paid channel immediately with role ping
    if (paidChannelId) {
      try {
        const paidChannel = await this.client.channels.fetch(paidChannelId);
        const content = paidRoleId ? `<@&${paidRoleId}>` : undefined;
        await paidChannel.send({ content, embeds: [embed] });
        logger.info(`Sent ${event.type} to paid channel: ${event.product.name}`);
      } catch (err) {
        logger.error(`Failed to send to paid channel: ${err.message}`);
      }
    }

    // Send to free channel after delay
    if (freeChannelId) {
      const delay = config.delivery.freeTierDelayMs;
      setTimeout(async () => {
        try {
          const freeChannel = await this.client.channels.fetch(freeChannelId);
          await freeChannel.send({ embeds: [embed] });
          logger.info(`Sent ${event.type} to free channel (delayed): ${event.product.name}`);
        } catch (err) {
          logger.error(`Failed to send to free channel: ${err.message}`);
        }
      }, delay);
    }
  }
}

module.exports = new DeliveryQueue();
