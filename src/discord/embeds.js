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
  [EVENT_TYPES.LISTING]: {
    label: 'Currently Listed',
    color: 0x9b59b6,
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

  // ── Author: retailer branding ──
  embed.setAuthor({ name: product.retailer });

  // ── Title: product name (clickable link) ──
  embed.setTitle(product.name);
  if (product.url) embed.setURL(product.url);

  // ── Thumbnail ──
  if (product.image) embed.setThumbnail(product.image);

  // ── Inline fields (Zephyr style) ──

  // Price field
  if (type === EVENT_TYPES.PRICE_CHANGE && oldValue != null && newValue != null) {
    const saved = oldValue - newValue;
    if (saved > 0) {
      const pct = ((saved / oldValue) * 100).toFixed(0);
      embed.addFields({ name: 'Price', value: `~~$${oldValue.toFixed(2)}~~ **$${newValue.toFixed(2)} CAD** (-${pct}%)`, inline: true });
    } else {
      embed.addFields({ name: 'Price', value: `$${newValue.toFixed(2)} CAD`, inline: true });
    }
  } else if (product.price != null && product.price > 0) {
    embed.addFields({ name: 'Price', value: `$${product.price.toFixed(2)} CAD`, inline: true });
  } else {
    embed.addFields({ name: 'Price', value: 'TBD', inline: true });
  }

  // Type field
  embed.addFields({ name: 'Type', value: cfg.label, inline: true });

  const isAmazon = product.retailerId === 'amazon';

  // SKU / ASIN field
  if (product.sku) {
    embed.addFields({ name: isAmazon ? 'ASIN' : 'SKU', value: String(product.sku), inline: true });
  }

  // Stock indicator
  if (product.stockCount != null && product.stockCount > 0) {
    embed.addFields({ name: 'Stock', value: String(product.stockCount), inline: true });
  } else if (isAmazon) {
    embed.addFields({ name: 'Stock', value: product.inStock ? '1+' : '\u{1F534}', inline: true });
  } else {
    const stockIcon = product.inStock ? '\u{1F7E2}' : '\u{1F534}';
    embed.addFields({ name: 'Online Stock', value: stockIcon, inline: true });
  }

  if (isAmazon && product.sku) {
    // ── Amazon-specific fields ──
    const asin = String(product.sku);
    const atcBase = `https://www.amazon.ca/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=`;

    // One Click Checkout (two inline fields, side by side)
    embed.addFields(
      { name: 'One Click Checkout', value: `[ATCx1](${atcBase}1) | [ATCx2](${atcBase}2)`, inline: true },
      { name: 'One Click Checkout', value: `[ATCx3](${atcBase}3) | [ATCx8](${atcBase}8)`, inline: true }
    );

    // Offer Id (ASIN in code block)
    embed.addFields({ name: 'Offer Id', value: `\`${asin}\``, inline: false });

    // Links
    const encodedName = encodeURIComponent(product.name || '');
    const links = [
      `[Login](https://www.amazon.ca/ap/signin)`,
      `[Cart](https://www.amazon.ca/gp/cart/view.html)`,
      `[Amazon Business](https://business.amazon.ca/)`,
      `[Keepa](https://keepa.com/#!product/6-${asin})`,
      `[Ebay](https://www.ebay.ca/sch/i.html?_nkw=${encodedName})`,
      `[Ebay Sales](https://www.ebay.ca/sch/i.html?_nkw=${encodedName}&LH_Complete=1&LH_Sold=1)`,
    ].join(' | ');
    embed.addFields({ name: 'Links', value: links, inline: false });
  } else {
    // ── Non-Amazon fields ──

    // Variant ID (Shopify)
    if (product._variantId) {
      embed.addFields({ name: 'Variant', value: String(product._variantId), inline: true });
    }

    // Cart status
    const cartIcon = product.canAddToCart ? '\u{1F7E2}' : '\u{1F534}';
    embed.addFields({ name: 'Add to Cart', value: cartIcon, inline: true });

    // Ships to home
    const shipIcon = product.shipsToHome ? '\u{1F7E2}' : '\u{1F534}';
    embed.addFields({ name: 'Ships Home', value: shipIcon, inline: true });
  }

  // ── Footer ──
  const tierLabel = tier === 'scan' ? 'Manual Scan' : tier === 'paid' ? 'Premium' : 'Free';
  embed.setFooter({ text: `Pulse Watch  ·  ${tierLabel}` });

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
