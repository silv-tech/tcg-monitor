const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { EVENT_TYPES } = require('../core/events');

// ─── Event config ────────────────────────────────────────────────
const EVENT_CONFIG = {
  [EVENT_TYPES.RESTOCK]: {
    label: 'Restock',
    color: 0x57f287,
    button: 'Buy Now',
  },
  [EVENT_TYPES.NEW_SKU]: {
    label: 'New Product',
    color: 0x5865f2,
    button: 'View Product',
  },
  [EVENT_TYPES.PRICE_CHANGE]: {
    label: 'Price Drop',
    color: 0xed4245,
    button: 'Buy Now',
  },
  [EVENT_TYPES.PREORDER_LIVE]: {
    label: 'Pre-Order Live',
    color: 0xfe7434,
    button: 'Pre-Order Now',
  },
  [EVENT_TYPES.CART_AVAILABLE]: {
    label: 'Cart Available',
    color: 0x3498db,
    button: 'Add to Cart',
  },
  [EVENT_TYPES.SHIPPING_CHANGE]: {
    label: 'Shipping Update',
    color: 0x95a5a6,
    button: 'View Product',
  },
};

// ─── Main builder ────────────────────────────────────────────────

function buildAlertEmbed(event, tier) {
  const { type, product, oldValue, newValue } = event;
  const cfg = EVENT_CONFIG[type] || EVENT_CONFIG[EVENT_TYPES.RESTOCK];

  const embed = new EmbedBuilder()
    .setColor(cfg.color)
    .setTimestamp();

  // ── Title: product name (clickable link) ──
  embed.setTitle(product.name);
  if (product.url) embed.setURL(product.url);

  // ── Author: retailer + event type ──
  embed.setAuthor({ name: `${product.retailer}  ·  ${cfg.label}` });

  // ── Thumbnail ──
  if (product.image) embed.setThumbnail(product.image);

  // ── Price line ──
  if (type === EVENT_TYPES.PRICE_CHANGE && oldValue != null && newValue != null) {
    const saved = oldValue - newValue;
    if (saved > 0) {
      const pct = ((saved / oldValue) * 100).toFixed(0);
      embed.setDescription(`~~$${oldValue.toFixed(2)}~~ **$${newValue.toFixed(2)} CAD** (-${pct}%)`);
    } else {
      embed.setDescription(`~~$${oldValue.toFixed(2)}~~ **$${newValue.toFixed(2)} CAD**`);
    }
  } else if (product.price != null) {
    embed.setDescription(`**$${product.price.toFixed(2)} CAD**`);
  }

  // ── Footer: stock + tier ──
  const stock = product.inStock ? 'In Stock' : 'Out of Stock';
  const tierLabel = tier === 'paid' ? 'Premium' : 'Free';
  embed.setFooter({ text: `${stock}  ·  ${tierLabel}  ·  TCG Monitor` });

  // ── Button ──
  const components = [];
  if (product.url) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(cfg.button)
          .setURL(product.url)
          .setStyle(ButtonStyle.Link)
      )
    );
  }

  return { embed, components };
}

// Backward compat
function buildEmbed(event) {
  const { embed } = buildAlertEmbed(event, 'paid');
  return embed;
}

module.exports = { buildEmbed, buildAlertEmbed };
