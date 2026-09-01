const logger = require('../monitoring/logger');

const EVENT_TYPES = {
  RESTOCK: 'RESTOCK',
  NEW_SKU: 'NEW_SKU',
  PRICE_CHANGE: 'PRICE_CHANGE',
  PREORDER_LIVE: 'PREORDER_LIVE',
  CART_AVAILABLE: 'CART_AVAILABLE',
  SHIPPING_CHANGE: 'SHIPPING_CHANGE',
  LISTING: 'LISTING',
};

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

  // Price change (only if both have valid prices)
  if (
    oldProduct.price != null &&
    newProduct.price != null &&
    oldProduct.price !== newProduct.price &&
    oldProduct.price > 0
  ) {
    const pctChange = ((newProduct.price - oldProduct.price) / oldProduct.price) * 100;
    events.push({
      type: EVENT_TYPES.PRICE_CHANGE,
      product: newProduct,
      detail: `Price ${pctChange < 0 ? 'dropped' : 'increased'} ${Math.abs(pctChange).toFixed(1)}%`,
      oldValue: oldProduct.price,
      newValue: newProduct.price,
    });
  }

  // Cart availability
  if (!oldProduct.canAddToCart && newProduct.canAddToCart) {
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

  // Shipping change
  if (oldProduct.shipsToHome !== newProduct.shipsToHome && newProduct.shipsToHome) {
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
