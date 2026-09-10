const logger = require('../monitoring/logger');

const EVENT_TYPES = {
  RESTOCK: 'RESTOCK',
  NEW_SKU: 'NEW_SKU',
  PRICE_CHANGE: 'PRICE_CHANGE',
  PREORDER_LIVE: 'PREORDER_LIVE',
  CART_AVAILABLE: 'CART_AVAILABLE',
  SHIPPING_CHANGE: 'SHIPPING_CHANGE',
  LISTING: 'LISTING',
  EARLY_SKU: 'EARLY_SKU',
};

// Only price DROPS alert, and only past this swing — small wobbles and increases aren't worth a ping
const MIN_PRICE_CHANGE_PCT = 9;

// ...and NOT past this one. A drop steeper than this is not a discount, it is bad data.
//
// A client's channel received "$5745.00 -> $52.00 (-99%)" on a sealed pack, alongside -99%, -95%
// and -77% on four more. Every one was a row whose cached price had come from the WRONG VARIANT of
// a multi-variant product; the low price was the true one and the high price was the corruption.
// Sealed product is not sold at ten cents on the dollar, so a drop of this depth says the OLD
// number was wrong far more often than it says the new one is a bargain.
//
// 90 is deliberately conservative. Measured across seven catalogues, legitimate clearance clusters
// in the 30-50% band and nothing real approached 90%. A lower floor would start eating genuine
// blowout sales, and a missed real drop costs the client more than a suppressed artifact does.
// This leaves a gray zone: the -77% case above still gets through. Closing that needs a
// confirm-on-second-observation rule rather than a deeper floor, which is a separate change.
const MAX_PRICE_DROP_PCT = Number(process.env.MAX_PRICE_DROP_PCT) || 90;

function detectEvents(oldProduct, newProduct) {
  const events = [];

  if (!oldProduct) {
    events.push({
      type: EVENT_TYPES.NEW_SKU,
      product: newProduct,
      detail: 'New product detected',
    });
    return events;
  }

  // Restock
  if (!oldProduct.inStock && newProduct.inStock) {
    events.push({
      type: EVENT_TYPES.RESTOCK,
      product: newProduct,
      detail: `Back in stock at ${newProduct.retailer}`,
      oldValue: false,
      newValue: true,
    });
  }

  // A move of almost exactly 100x is a currency-unit change, not a price change. Some Shopify
  // stores quote cents, and when a store's unit is re-detected (or the store itself switches),
  // every cached price shifts by 100 at once — which would otherwise read as a 99% crash on the
  // entire catalogue and fire a price-drop alert for every product in it.
  const unitShift = oldProduct.price > 0 && newProduct.price > 0
    && (() => {
      const ratio = Math.max(oldProduct.price, newProduct.price) / Math.min(oldProduct.price, newProduct.price);
      return Math.abs(ratio - 100) < 0.5;
    })();

  // Price drop (only if both have valid prices and the drop clears the minimum swing)
  if (
    oldProduct.price != null &&
    newProduct.price != null &&
    oldProduct.price !== newProduct.price &&
    oldProduct.price > 0 &&
    newProduct.price > 0 &&
    !unitShift
  ) {
    const pctChange = ((newProduct.price - oldProduct.price) / oldProduct.price) * 100;
    const tooSteep = pctChange <= -MAX_PRICE_DROP_PCT;
    if (tooSteep) {
      // Logged, never dropped in silence. The cause is a row-identity defect, and the same bad
      // price also feeds the price-history shown in the embed and the cross-retailer comparison —
      // both silent. Suppressing without a record would hide the defect while it kept corrupting
      // other rows, which is how this went unnoticed until a customer saw -99%.
      logger.warn(`IMPLAUSIBLE PRICE DROP suppressed: ${newProduct.retailerId || '?'}:${newProduct.sku} `
        + `${oldProduct.price} -> ${newProduct.price} (${pctChange.toFixed(1)}%, ratio `
        + `${(oldProduct.price / newProduct.price).toFixed(1)}x) | ${newProduct.name}`);
    } else if (pctChange <= -MIN_PRICE_CHANGE_PCT) {
      events.push({
        type: EVENT_TYPES.PRICE_CHANGE,
        product: newProduct,
        detail: `Price dropped ${Math.abs(pctChange).toFixed(1)}%`,
        oldValue: oldProduct.price,
        newValue: newProduct.price,
      });
    }
  }

  // Cart availability — only if RESTOCK didn't already fire (avoids duplicate alerts)
  const alreadyRestocked = events.some(e => e.type === EVENT_TYPES.RESTOCK);
  if (!alreadyRestocked && !oldProduct.canAddToCart && newProduct.canAddToCart) {
    events.push({
      type: EVENT_TYPES.CART_AVAILABLE,
      product: newProduct,
      detail: 'Add to cart now available',
    });
  }

  // Pre-order live
  if (!oldProduct.isPreorderable && newProduct.isPreorderable) {
    events.push({
      type: EVENT_TYPES.PREORDER_LIVE,
      product: newProduct,
      detail: `Pre-order now available at ${newProduct.retailer}`,
    });
  }

  // Shipping change — only if RESTOCK didn't already fire (avoids triple alerts)
  if (!alreadyRestocked && oldProduct.shipsToHome !== newProduct.shipsToHome && newProduct.shipsToHome) {
    events.push({
      type: EVENT_TYPES.SHIPPING_CHANGE,
      product: newProduct,
      detail: 'Now ships to home',
      oldValue: oldProduct.shipsToHome,
      newValue: newProduct.shipsToHome,
    });
  }

  return events;
}

function diffProducts(oldProducts, newProducts) {
  const allEvents = [];

  for (const [sku, newProd] of Object.entries(newProducts)) {
    const oldProd = oldProducts[sku] || null;
    const events = detectEvents(oldProd, newProd);
    allEvents.push(...events);
  }

  return allEvents;
}

module.exports = { EVENT_TYPES, detectEvents, diffProducts };
