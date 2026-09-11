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
  'build and battle', 'build & battle', 'battle deck', 'league battle',
  'starter deck', 'structure deck',
  'ultra premium', 'poster collection', 'tech sticker',
  'trainer gallery', 'expansion pack',
  ' tin', 'tin ', ' box', 'box ', ' pack', 'pack ',
  'sealed', 'booster',
];

const NON_TCG_KEYWORDS = [
  // An audio player, not a card product. 'box ' in TCG_KEYWORDS matches inside "toniebox 2",
  // so this scored as sealed Pokemon product on both gates — see the note in scope.js.
  'tonie',
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
  't-shirt', 'hoodie', 'baseball hat', 'bucket hat', 'beanie', 'snapback',
  'baseball cap', 'trucker cap', 'mug', 'poster ',
  'funko', 'pop!', 'nendoroid', 'statue', 'model kit',
  'lego', 'mega construx', 'building set', 're-ment', 'rement',
  'dvd', 'blu-ray', 'movie', 'season ',
  'final blast', 'dragon stars', 'super warrior',
  // Board games / party games
  'cards against humanity', 'monopoly', 'uno ', 'uno:', 'phase 10',
  'exploding kittens', 'codenames', 'catan', 'risk ', 'clue ',
  'sorry!', 'skip-bo', 'skip bo', 'skipbo', 'sequence', 'apples to apples',
];

/**
 * Sealed product forms that must WIN over a generic exclusion word.
 *
 * 'poster collection' is listed in TCG_KEYWORDS and 'poster ' in NON_TCG_KEYWORDS, and because
 * the exclusion is tested first it always won — so "Pokemon TCG: 30th Celebration Poster
 * Collection" was rejected as merchandise. It is not merchandise: it is a sealed box of packs
 * with a promo, it was BUYABLE on amazon.ca at $27.99 while we ignored it, and a competitor
 * alerted on it. scope.js already treats poster/sticker collections as sealed forms; this is
 * the same rule applied to the older list the two disagreed on.
 *
 * A bare "Charizard Wall Poster" still has no sealed form in it and stays excluded.
 */
const SEALED_FORM_RESCUE = ['poster collection', 'sticker collection'];

function isTCGProduct(name) {
  const lower = name.toLowerCase();
  // A named sealed form settles it, whatever else the title happens to contain.
  if (SEALED_FORM_RESCUE.some(kw => lower.includes(kw))) return true;
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
