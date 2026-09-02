const { EmbedBuilder } = require('discord.js');
const { EVENT_TYPES } = require('../core/events');
const { truncate } = require('../utils/helpers');

// ─── Event config ────────────────────────────────────────────────
const EVENT_CONFIG = {
  [EVENT_TYPES.RESTOCK]: {
    label: 'Restock',
    color: 0x57f287,
  },
  [EVENT_TYPES.NEW_SKU]: {
    label: 'New Product',
    color: 0x5865f2,
  },
  [EVENT_TYPES.PRICE_CHANGE]: {
    label: 'Price Drop',
    color: 0xed4245,
  },
  [EVENT_TYPES.PREORDER_LIVE]: {
    label: 'Pre-Order Live',
    color: 0xfe7434,
  },
  [EVENT_TYPES.CART_AVAILABLE]: {
    label: 'Cart Available',
    color: 0x3498db,
  },
  [EVENT_TYPES.SHIPPING_CHANGE]: {
    label: 'Shipping Update',
    color: 0x95a5a6,
  },
  [EVENT_TYPES.LISTING]: {
    label: 'Currently Listed',
    color: 0x9b59b6,
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
  const entries = history.slice(-5);
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
  embed.setTitle(truncate(product.name, 256));
  const safeUrl = isAmazon && product.sku
    ? `https://www.amazon.ca/dp/${product.sku}`
    : product.url && product.url.length <= 2048 ? product.url : null;
  if (safeUrl) embed.setURL(safeUrl);

  // ── Thumbnail ──
  if (product.image) embed.setThumbnail(product.image);

  // ── Inline fields ──

  // Price
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

  // Type
  embed.addFields({ name: 'Type', value: cfg.label, inline: true });

  // SKU / ASIN
  if (product.sku) {
    embed.addFields({ name: isAmazon ? 'ASIN' : 'SKU', value: String(product.sku), inline: true });
  }

  // ── Stock ──
  if (product.stockCount != null && product.stockCount > 0) {
    embed.addFields({ name: 'Stock', value: String(product.stockCount), inline: true });
  } else {
    embed.addFields({ name: 'Stock', value: product.inStock ? '1+' : '\u{1F534}', inline: true });
  }

  // ── Variant ID (Shopify only) ──
  if (product._variantId) {
    embed.addFields({ name: 'Variant', value: String(product._variantId), inline: true });
  }

  // ── Offer Id (Amazon only — different from ASIN, used for direct cart links) ──
  if (isAmazon && event._offerListingId) {
    embed.addFields({ name: 'Offer Id', value: `\`${event._offerListingId}\``, inline: false });
  }

  // ── One Click Checkout (markdown links in embed fields — matches client's preferred format) ──
  if (isAmazon && product.sku) {
    const asin = String(product.sku);
    const atcBase = `https://www.amazon.ca/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=`;
    embed.addFields(
      { name: 'One Click Checkout', value: `[ATCx1](${atcBase}1) | [ATCx2](${atcBase}2)`, inline: false },
      { name: 'One Click Checkout', value: `[ATCx3](${atcBase}3) | [ATCx12](${atcBase}12)`, inline: false },
    );
  } else if (product._variantId && product.url) {
    try {
      const origin = new URL(product.url).origin;
      const vid = product._variantId;
      embed.addFields(
        { name: 'One Click Checkout', value: `[ATCx1](${origin}/cart/${vid}:1) | [ATCx2](${origin}/cart/${vid}:2)`, inline: false },
        { name: 'One Click Checkout', value: `[ATCx3](${origin}/cart/${vid}:3)`, inline: false },
      );
    } catch {
      // Invalid URL — skip ATC
    }
  }

  // ── Links (store-specific + universal) ──
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
  } else if (product.retailerId === 'walmart') {
    links.push(
      `[Login](https://www.walmart.ca/sign-in)`,
      `[Cart](https://www.walmart.ca/cart)`,
    );
    if (product.sku) links.push(`[Product](https://www.walmart.ca/en/ip/${product.sku})`);
  } else if (product.retailerId === 'costco') {
    links.push(
      `[Login](https://www.costco.ca/LogonForm)`,
      `[Cart](https://www.costco.ca/AjaxOrderItemDisplayView)`,
    );
  } else if (product.retailerId === 'pokemoncenter') {
    links.push(
      `[Login](https://www.pokemoncenter.com/login)`,
      `[Cart](https://www.pokemoncenter.com/cart)`,
    );
  } else if (product.retailerId === 'bestbuy') {
    links.push(
      `[Login](https://www.bestbuy.ca/identity/global/signin)`,
      `[Cart](https://www.bestbuy.ca/en-ca/basket)`,
    );
    if (product.sku) links.push(`[Product](https://www.bestbuy.ca/en-ca/product/${product.sku})`);
  }
  links.push(
    `[Ebay](https://www.ebay.ca/sch/i.html?_nkw=${encodedName})`,
    `[Ebay Sales](https://www.ebay.ca/sch/i.html?_nkw=${encodedName}&LH_Complete=1&LH_Sold=1)`,
  );
  const linksValue = truncate(links.join(' | '), 1024);
  embed.addFields({ name: 'Links', value: linksValue, inline: false });

  // ── Restock History ──
  const restockValue = buildRestockHistoryValue(event._restockHistory);
  if (restockValue) {
    embed.addFields({ name: 'Restock History', value: restockValue, inline: false });
  }

  // ── Price History ──
  const priceValue = buildPriceHistoryValue(event._priceHistory);
  if (priceValue) {
    embed.addFields({ name: 'Price History', value: priceValue, inline: false });
  }

  // ── Cross-Retailer Price Check ──
  const crossValue = buildCrossRetailerValue(event._crossRetailer);
  if (crossValue) {
    embed.addFields({ name: 'Also In Stock', value: crossValue, inline: false });
  }

  // ── Footer with detection speed + freshness ──
  const tierLabel = tier === 'scan' ? 'Manual Scan' : tier === 'paid' ? 'Premium' : 'Free';
  let footerText = `Nocturne Monitors  ·  ${tierLabel}`;
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

  // No Discord buttons — all ATC links are markdown in embed fields (client preferred format)
  const components = [];

  return { embed, components };
}

// Backward compat
function buildEmbed(event) {
  const { embed } = buildAlertEmbed(event, 'paid');
  return embed;
}

module.exports = { buildEmbed, buildAlertEmbed };
