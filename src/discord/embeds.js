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

// ─── Helpers ─────────────────────────────────────────────────────

function formatDaysAgo(ts) {
  const days = Math.round((Date.now() - ts) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

function buildRestockHistoryValue(history) {
  if (!history || history.length === 0) return null;
  const last = history[history.length - 1];
  if (history.length === 1) return `Last: ${formatDaysAgo(last)}`;
  // Average interval between restocks
  let totalGap = 0;
  for (let i = 1; i < history.length; i++) {
    totalGap += history[i] - history[i - 1];
  }
  const avgDays = Math.round(totalGap / (history.length - 1) / 86400000);
  return `Last: ${formatDaysAgo(last)} · Avg: every ~${avgDays}d`;
}

function buildCrossRetailerValue(matches) {
  if (!matches || matches.length === 0) return null;
  return matches.map(m => {
    const name = m.url ? `[${m.retailer}](${m.url})` : m.retailer;
    return `${name} — $${m.price.toFixed(2)}`;
  }).join(' | ');
}

function buildPriceHistoryValue(history) {
  if (!history || history.length < 2) return null;
  const entries = history.slice(-5); // last 5 price points
  return entries.map(h => {
    const daysAgo = formatDaysAgo(h.time);
    return `$${h.price.toFixed(2)} (${daysAgo})`;
  }).join(' → ');
}

function formatFreshness(lastCheckedAt) {
  if (!lastCheckedAt) return null;
  const agoMs = Date.now() - lastCheckedAt;
  if (agoMs < 60000) return `${Math.round(agoMs / 1000)}s ago`;
  if (agoMs < 3600000) return `${Math.round(agoMs / 60000)}m ago`;
  return `${Math.round(agoMs / 3600000)}h ago`;
}

// ─── Main builder ────────────────────────────────────────────────

function buildAlertEmbed(event, tier) {
  const { type, product, oldValue, newValue } = event;
  const cfg = EVENT_CONFIG[type] || EVENT_CONFIG[EVENT_TYPES.RESTOCK];

  const isAmazon = product.retailerId === 'amazon';

  const embed = new EmbedBuilder()
    .setColor(cfg.color)
    .setTimestamp();

  // ── Author: retailer branding ──
  embed.setAuthor({ name: product.retailer });

  // ── Title: product name (clickable link) ──
  embed.setTitle(product.name);
  // Use short URL for Amazon (/dp/ASIN), truncate others to Discord's 2048 limit
  const safeUrl = isAmazon && product.sku
    ? `https://www.amazon.ca/dp/${product.sku}`
    : product.url && product.url.length <= 2048 ? product.url : null;
  if (safeUrl) embed.setURL(safeUrl);

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

  // SKU / ASIN field
  if (product.sku) {
    embed.addFields({ name: isAmazon ? 'ASIN' : 'SKU', value: String(product.sku), inline: true });
  }

  // ── Stock (unified — count when known, 1+ when in stock, red when OOS) ──
  if (product.stockCount != null && product.stockCount > 0) {
    embed.addFields({ name: 'Stock', value: String(product.stockCount), inline: true });
  } else {
    embed.addFields({ name: 'Stock', value: product.inStock ? '1+' : '\u{1F534}', inline: true });
  }

  // ── Variant ID (Shopify only — useful for manual checkout) ──
  if (product._variantId) {
    embed.addFields({ name: 'Variant', value: String(product._variantId), inline: true });
  }

  // ── Offer Listing ID (Amazon only — scraped from product page, cached 30 days) ──
  if (isAmazon && event._offerListingId) {
    embed.addFields({ name: 'Offer Id', value: event._offerListingId, inline: false });
  }

  // ── Restock History (all retailers) ──
  const restockValue = buildRestockHistoryValue(event._restockHistory);
  if (restockValue) {
    embed.addFields({ name: 'Restock History', value: restockValue, inline: false });
  }

  // ── Price History (all retailers) ──
  const priceValue = buildPriceHistoryValue(event._priceHistory);
  if (priceValue) {
    embed.addFields({ name: 'Price History', value: priceValue, inline: false });
  }

  // ── Cross-Retailer Price Check (all retailers) ──
  const crossValue = buildCrossRetailerValue(event._crossRetailer);
  if (crossValue) {
    embed.addFields({ name: 'Also In Stock', value: crossValue, inline: false });
  }

  // ── Links (all retailers get eBay, Amazon gets extras) ──
  const encodedName = encodeURIComponent(product.name || '');
  const links = [];
  if (isAmazon && product.sku) {
    const asin = String(product.sku);
    links.push(
      `[Login](https://www.amazon.ca/ap/signin)`,
      `[Cart](https://www.amazon.ca/gp/cart/view.html)`,
      `[Amazon Business](https://www.amazon.ca/business)`,
      `[Keepa](https://keepa.com/#!product/6-${asin})`,
    );
  }
  links.push(
    `[Ebay](https://www.ebay.ca/sch/i.html?_nkw=${encodedName})`,
    `[Ebay Sales](https://www.ebay.ca/sch/i.html?_nkw=${encodedName}&LH_Complete=1&LH_Sold=1)`,
  );
  embed.addFields({ name: 'Links', value: links.join(' | '), inline: false });

  // ── Footer with detection speed + freshness ──
  const tierLabel = tier === 'scan' ? 'Manual Scan' : tier === 'paid' ? 'Premium' : 'Free';
  let footerText = `Pulse Watch  ·  ${tierLabel}`;
  if (event._detectedAt) {
    const speedMs = Date.now() - event._detectedAt;
    const speedSec = (speedMs / 1000).toFixed(1);
    footerText += `  ·  \u26A1 ${speedSec}s`;
  }
  const freshness = formatFreshness(event._lastCheckedAt);
  if (freshness) {
    footerText += `  ·  Checked: ${freshness}`;
  }
  embed.setFooter({ text: footerText });

  // ── Buttons (real Discord buttons, not markdown links) ──
  const components = [];

  // Row 1: Buy Now / View Product
  const buttonUrl = isAmazon && product.sku
    ? `https://www.amazon.ca/dp/${product.sku}`
    : product.url;
  if (buttonUrl && buttonUrl.length <= 512) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(cfg.button)
          .setURL(buttonUrl)
          .setStyle(ButtonStyle.Link)
      )
    );
  }

  // Row 2: ATC buttons (Amazon: cart/add API, Shopify: /cart/variant:qty)
  if (isAmazon && product.sku) {
    const asin = String(product.sku);
    const atcBase = `https://www.amazon.ca/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=`;
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('ATCx1').setURL(`${atcBase}1`).setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('ATCx2').setURL(`${atcBase}2`).setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('ATCx3').setURL(`${atcBase}3`).setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('ATCx12').setURL(`${atcBase}12`).setStyle(ButtonStyle.Link),
      )
    );
  } else if (product._variantId && product.url) {
    try {
      const origin = new URL(product.url).origin;
      const vid = product._variantId;
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('ATCx1').setURL(`${origin}/cart/${vid}:1`).setStyle(ButtonStyle.Link),
          new ButtonBuilder().setLabel('ATCx2').setURL(`${origin}/cart/${vid}:2`).setStyle(ButtonStyle.Link),
          new ButtonBuilder().setLabel('ATCx3').setURL(`${origin}/cart/${vid}:3`).setStyle(ButtonStyle.Link),
        )
      );
    } catch {
      // Invalid URL — skip ATC buttons
    }
  }

  return { embed, components };
}

// Backward compat
function buildEmbed(event) {
  const { embed } = buildAlertEmbed(event, 'paid');
  return embed;
}

module.exports = { buildEmbed, buildAlertEmbed };
