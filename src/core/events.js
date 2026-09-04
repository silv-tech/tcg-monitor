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
    if (pctChange <= -MIN_PRICE_CHANGE_PCT) events.push({
      type: EVENT_TYPES.PRICE_CHANGE,
      product: newProduct,
      detail: `Price dropped ${Math.abs(pctChange).toFixed(1)}%`,
      oldValue: oldProduct.price,
      newValue: newProduct.price,
    });
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
