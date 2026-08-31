const state = require('../core/state');
const logger = require('../monitoring/logger');

const PREFIX = 'tcg:dedup:';
const DEDUP_TTL = 600; // 10 minutes — allows legitimate rapid restocks (P1-3)

function eventKey(event) {
  const { type, product } = event;
  // Include stock state so OOS→restock→OOS→restock generates unique keys
  const stateHash = type === 'RESTOCK' ? `:${product.inStock ? '1' : '0'}` : '';
  return `${PREFIX}${type}:${product.retailer}:${product.sku}${stateHash}`;
}

async function isDuplicate(event) {
  const key = eventKey(event);
  const existing = await state.getRedis().get(key);
  return !!existing;
}

async function markSent(event) {
  const key = eventKey(event);
  await state.getRedis().set(key, '1', 'EX', DEDUP_TTL);
}

async function filterDuplicates(events) {
  const unique = [];
  for (const event of events) {
    if (await isDuplicate(event)) {
      logger.debug(`Dedup: skipping ${event.type} for ${event.product.sku}`);
      continue;
    }
    unique.push(event);
  }
  return unique;
}

module.exports = { isDuplicate, markSent, filterDuplicates };
