function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classifyCategory(name, categories) {
  const lower = name.toLowerCase();
  for (const [cat, keywords] of Object.entries(categories)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return 'other';
}

function normalizePrice(priceStr) {
  if (typeof priceStr === 'number') return priceStr;
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function hashSku(retailer, sku) {
  return `${retailer}:${sku}`;
}

// TCG product keywords — if a product name matches a game category but none of these,
// it's probably not a card game product (e.g. action figures, plushies, video games)
const TCG_KEYWORDS = [
  'tcg', 'card game', 'trading card', 'booster', 'elite trainer', 'etb',
  'tin ', ' tin', 'blister', 'bundle box', 'booster bundle', 'collection box',
  'premium collection', 'special collection', 'build and battle', 'league battle',
  'starter deck', 'structure deck', 'sealed', 'display', 'case ', ' case',
  'pack ', ' pack', ' box', 'box ', 'ultra premium', 'poster collection',
  'tech sticker', 'binder', 'playmat', 'deck box', 'sleeves', 'card binder',
  'booster pack', 'expansion', 'trainer gallery',
];

const NON_TCG_KEYWORDS = [
  'action figure', 'figure series', 'plush', 'stuffed', 'figurine',
  'video game', 'nintendo switch', 'ps4', 'ps5', 'xbox',
  'board game', 'puzzle', 'costume', 'backpack', 'clothing',
  't-shirt', 'hoodie', 'hat ', 'cap ', 'mug', 'poster ',
  'funko', 'pop!', 'nendoroid', 'statue', 'model kit',
  'lego', 'mega construx', 'building set',
  'dvd', 'blu-ray', 'movie', 'season ',
  'final blast', 'dragon stars', 'super warrior',
  'cards against humanity', 'monopoly', 'uno ', 'uno:', 'phase 10',
  'exploding kittens', 'codenames', 'catan', 'risk ', 'clue ',
  'sorry!', 'skip-bo', 'sequence', 'apples to apples',
  'card storage', 'storage box', 'card organizer', 'card holder',
  'card sleeves', 'card protector', 'toploader', 'top loader',
];

function isTCGProduct(name) {
  const lower = name.toLowerCase();
  // Explicit non-TCG trumps everything
  if (NON_TCG_KEYWORDS.some(kw => lower.includes(kw))) return false;
  // Must contain at least one TCG keyword
  return TCG_KEYWORDS.some(kw => lower.includes(kw));
}

function truncate(str, len = 256) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len - 3) + '...' : str;
}

module.exports = { sleep, classifyCategory, normalizePrice, hashSku, truncate, isTCGProduct };
