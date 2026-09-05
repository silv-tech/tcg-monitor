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
  'EARLY_SKU': {
    label: 'Early Detection',
    color: 0xff9900,
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
  const avgMs = totalGap / (history.length - 1);
  // Sub-day gaps rounded to "~0d", which tells the reader nothing. Restocks on a hot product
  // are often hours apart, so fall back to hours (and then minutes) rather than printing zero.
  let avg;
  if (avgMs >= 86400000) avg = `${Math.round(avgMs / 86400000)}d`;
  else if (avgMs >= 3600000) avg = `${Math.round(avgMs / 3600000)}h`;
  else avg = `${Math.max(1, Math.round(avgMs / 60000))}m`;
  return `Last: ${formatDaysAgo(last)} · Avg: every ~${avg}`;
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

/**
 * How long from the listing going live to this alert being sent.
 *
 * Three different things can be measured here and only one of them is the promise we make to
 * a customer:
 *
 *   1. published_at -> now. TRUE end-to-end latency. Shopify gives us this, so for those 31
 *      stores the number is exact: a listing that went up at 16:00:00 and alerts at 16:00:09
 *      reads 9.0s, which is what "under 10 seconds" has to mean.
 *   2. previous poll -> now. For retailers that publish no timestamp we cannot know when the
 *      listing appeared, only that it was not there last time we looked. The true latency is
 *      somewhere inside that window, so we report its upper bound with a "≤".
 *   3. fetch start -> now. What this used to show. It is just our own request duration —
 *      ~1s regardless of a 30s poll cycle — and it made the alerts look far faster than the
 *      product actually was.
 *
 * A RESTOCK is not a new listing, so published_at does not apply: the product was already
 * live and what we detected was an availability change. Those fall through to the window.
 */
function alertSpeed(event) {
  const now = Date.now();
  const publishedAt = event.product && event.product.publishedAt;

  if (event.type === EVENT_TYPES.NEW_SKU && publishedAt) {
    const ms = now - publishedAt;
    // A shop can publish with a backdated timestamp, and a first-ever poll surfaces a whole
    // catalogue of old listings. Neither is a detection latency, so don't dress it up as one.
    if (ms >= 0 && ms < 10 * 60 * 1000) return `${(ms / 1000).toFixed(1)}s`;
    return null;
  }

  if (event._prevPollAt) {
    const ms = now - event._prevPollAt;
    if (ms >= 0 && ms < 10 * 60 * 1000) return `≤${(ms / 1000).toFixed(1)}s`;
  }

  // Nothing trustworthy to report. Saying nothing beats quoting our own request duration.
  return null;
}

// ─── Main builder ────────────────────────────────────────────────

function buildAlertEmbed(event, tier) {
  const { type, product, oldValue, newValue } = event;
  const cfg = EVENT_CONFIG[type] || EVENT_CONFIG[EVENT_TYPES.RESTOCK];

  const isAmazon = product.retailerId === 'amazon';
  const isFree = tier === 'free';

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

  // ── PAID-ONLY FIELDS ──────────────────────────────────────────
  if (!isFree) {
    // SKU / ASIN
    if (product.sku) {
      embed.addFields({ name: isAmazon ? 'ASIN' : 'SKU', value: String(product.sku), inline: true });
    }

    // Stock — prefer exact quantity from Walmart/Shopify, fallback to 1+
    const stockQty = product._stockQty || product.stockCount;
    if (stockQty != null && stockQty > 0) {
      embed.addFields({ name: 'Stock', value: String(stockQty), inline: true });
    } else {
      embed.addFields({ name: 'Stock', value: product.inStock ? '1+' : '\u{1F534}', inline: true });
    }

    if (product._cartLimit) {
      embed.addFields({ name: 'Cart Limit', value: String(product._cartLimit), inline: true });
    }

    // Odoo product id (EB Games)
    if (product._productId) {
      embed.addFields({ name: 'Product ID', value: String(product._productId), inline: true });
    }

    // Variant ID (Shopify only)
    if (product._variantId) {
      embed.addFields({ name: 'Variant', value: String(product._variantId), inline: true });
    }

    // Offer Id (Amazon OLID or Walmart offerId — per-seller, used for ATC)
    const offerId = (isAmazon && event._offerListingId) ? event._offerListingId : product._offerId;
    if (offerId) {
      embed.addFields({ name: 'Offer Id', value: `\`${offerId}\``, inline: false });
    }

    // One Click Checkout
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

    // Links (store-specific + universal)
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

    // Restock History
    const restockValue = buildRestockHistoryValue(event._restockHistory);
    if (restockValue) {
      embed.addFields({ name: 'Restock History', value: restockValue, inline: false });
    }

    // Price History
    const priceValue = buildPriceHistoryValue(event._priceHistory);
    if (priceValue) {
      embed.addFields({ name: 'Price History', value: priceValue, inline: false });
    }

    // Cross-Retailer Price Check
    const crossValue = buildCrossRetailerValue(event._crossRetailer);
    if (crossValue) {
      embed.addFields({ name: 'Also In Stock', value: crossValue, inline: false });
    }
  } else {
    // ── FREE TIER: minimal links ──
    const encodedName = encodeURIComponent(product.name || '');
    const freeLinks = [
      `[Ebay](https://www.ebay.ca/sch/i.html?_nkw=${encodedName})`,
      `[Ebay Sales](https://www.ebay.ca/sch/i.html?_nkw=${encodedName}&LH_Complete=1&LH_Sold=1)`,
    ];
    embed.addFields({ name: 'Links', value: freeLinks.join(' | '), inline: false });

    // Upgrade CTA
    embed.addFields({ name: '\u200B', value: '\u{1F512} *Upgrade to Premium for instant alerts, ATC links, stock counts, restock history, price tracking & 20+ more stores*', inline: false });
  }

  // ── Footer ──
  const tierLabel = tier === 'scan' ? 'Manual Scan' : tier === 'paid' ? 'Premium' : 'Free';
  // eslint-disable-next-line no-use-before-define -- alertSpeed is hoisted

  let footerText = `Nocturne Monitors  ·  ${tierLabel}`;
  // Detection speed + freshness — paid only
  if (!isFree) {
    // What this number MEANS matters. It was Date.now() - _detectedAt, and _detectedAt is set
    // when our fetch STARTS, so it reported how long our own request took (~1s) even when the
    // poll interval was 30s and the listing had already been live for half a minute. That
    // reads as a promise we are not keeping.
    //
    // The honest figure runs from when the listing went live to when this alert is sent.
    // Shopify exposes published_at, so for those stores it is exact. Retailers that publish no
    // timestamp cannot be measured that way, so we report the upper bound of the window it
    // could have appeared in rather than claiming a precision we do not have.
    const speed = alertSpeed(event);
    if (speed) footerText += `  ·  ⚡ ${speed}`;
  }
  if (!isFree) {
    const freshness = formatFreshness(event._lastCheckedAt);
    if (freshness) {
      footerText += `  ·  Checked: ${freshness}`;
    }
  }
  embed.setFooter({ text: footerText });

  const components = [];

  return { embed, components };
}

// Backward compat
function buildEmbed(event) {
  const { embed } = buildAlertEmbed(event, 'paid');
  return embed;
}

module.exports = { buildEmbed, buildAlertEmbed };
