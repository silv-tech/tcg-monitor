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

// TCG sealed product keywords — matches actual sealed card products
const TCG_KEYWORDS = [
  'tcg', 'card game', 'trading card',
  'booster box', 'booster pack', 'booster bundle', 'booster display',
  'elite trainer', 'etb', 'blister', 'bundle box',
  'collection box', 'premium collection', 'special collection', 'collection',
  'build and battle', 'league battle', 'starter deck', 'structure deck',
  'ultra premium', 'poster collection', 'tech sticker',
  'trainer gallery', 'expansion pack',
  ' tin', 'tin ', ' box', 'box ', ' pack', 'pack ',
  'sealed', 'booster',
];

const NON_TCG_KEYWORDS = [
  // Accessories — not sealed product
  'deck box', 'deckbox', 'playmat', 'play mat', 'binder', 'card binder',
  'sleeves', 'card sleeves', 'penny sleeves', 'card protector', 'protector case',
  'toploader', 'top loader', 'display case', 'acrylic', 'portfolio',
  'card storage', 'storage box', 'card organizer', 'card holder',
  'pet plastic', 'dice set', 'dice bag', 'coin holder', 'token box',
  // Bags and tags. Pokemon Center titles many of these "Pokemon TCG ..." even though they
  // hold no cards, so the franchise words alone let them through: "Pokemon TCG Celestial
  // Espeon and Umbreon Bag Tag" and "... Convertible Shoulder Bag" both passed as sealed
  // product before this. The client wants cards, not merchandise.
  'bag tag', 'shoulder bag', 'tote bag', 'duffel', 'lanyard', 'keychain', 'key chain',
  'pin collection', 'enamel pin', 'wallet', 'pouch', 'sticker sheet',
  // Figures, toys, clothing
  'action figure', 'figure series', 'plush', 'stuffed', 'figurine',
  'video game', 'nintendo switch', 'ps4', 'ps5', 'xbox',
  'board game', 'puzzle', 'costume', 'backpack', 'clothing',
  't-shirt', 'hoodie', 'hat ', 'cap ', 'mug', 'poster ',
  'funko', 'pop!', 'nendoroid', 'statue', 'model kit',
  'lego', 'mega construx', 'building set',
  'dvd', 'blu-ray', 'movie', 'season ',
  'final blast', 'dragon stars', 'super warrior',
  // Board games / party games
  'cards against humanity', 'monopoly', 'uno ', 'uno:', 'phase 10',
  'exploding kittens', 'codenames', 'catan', 'risk ', 'clue ',
  'sorry!', 'skip-bo', 'skip bo', 'skipbo', 'sequence', 'apples to apples',
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
