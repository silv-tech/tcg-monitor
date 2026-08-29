const { EmbedBuilder } = require('discord.js');
const { EVENT_TYPES } = require('../core/events');

const EVENT_EMOJI = {
  [EVENT_TYPES.RESTOCK]: '🟢',
  [EVENT_TYPES.NEW_SKU]: '🆕',
  [EVENT_TYPES.PRICE_CHANGE]: '💰',
  [EVENT_TYPES.PREORDER_LIVE]: '📋',
  [EVENT_TYPES.CART_AVAILABLE]: '🛒',
  [EVENT_TYPES.SHIPPING_CHANGE]: '📦',
};

const EVENT_TITLE = {
  [EVENT_TYPES.RESTOCK]: 'Back in Stock!',
  [EVENT_TYPES.NEW_SKU]: 'New Product Found!',
  [EVENT_TYPES.PRICE_CHANGE]: 'Price Change',
  [EVENT_TYPES.PREORDER_LIVE]: 'Pre-Order Live!',
  [EVENT_TYPES.CART_AVAILABLE]: 'Add to Cart Available!',
  [EVENT_TYPES.SHIPPING_CHANGE]: 'Shipping Update',
};

function buildEmbed(event) {
  const { type, product, detail, oldValue, newValue } = event;
  const emoji = EVENT_EMOJI[type] || '📢';
  const title = EVENT_TITLE[type] || type;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${title}`)
    .setURL(product.url || null)
    .setDescription(`**${product.name}**`)
    .setColor(resolveColor(product))
    .setTimestamp()
    .setFooter({ text: `${product.retailer} • TCG Monitor` });

  if (product.image) {
    embed.setThumbnail(product.image);
  }

  if (product.price != null) {
    embed.addFields({ name: 'Price', value: `$${product.price.toFixed(2)} CAD`, inline: true });
  }

  if (type === EVENT_TYPES.PRICE_CHANGE && oldValue != null) {
    const diff = newValue - oldValue;
    const arrow = diff < 0 ? '↓' : '↑';
    embed.addFields({
      name: 'Was',
      value: `$${oldValue.toFixed(2)} CAD`,
      inline: true,
    });
    embed.addFields({
      name: 'Change',
      value: `${arrow} $${Math.abs(diff).toFixed(2)}`,
      inline: true,
    });
  }

  embed.addFields(
    { name: 'Stock', value: product.inStock ? '✅ In Stock' : '❌ Out of Stock', inline: true },
    { name: 'Retailer', value: product.retailer, inline: true }
  );

  if (product.category && product.category !== 'other') {
    embed.addFields({ name: 'Category', value: product.category, inline: true });
  }

  embed.addFields({ name: '\u200b', value: `[Buy Now](${product.url})` });

  return embed;
}

function resolveColor(product) {
  const colorMap = {
    'EB Games': 0xe31937,
    'Costco Canada': 0xe31837,
    'Pokemon Center': 0xffcb05,
    'Walmart Canada': 0x0071dc,
    'Amazon Canada': 0xff9900,
  };
  return colorMap[product.retailer] || 0x5865f2;
}

module.exports = { buildEmbed };
