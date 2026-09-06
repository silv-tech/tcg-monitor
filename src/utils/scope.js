/**
 * One scope rule for every retailer.
 *
 * This used to live inside the Amazon adapter, and Walmart had no scope test at all — which
 * is why Walmart tracked 190 out-of-scope products out of 360 (UNO, Jenga, Monopoly, Twister,
 * Cards Against Humanity, He-Man figures, Dragon Ball) and alerted on 49 of them. Walmart's
 * search queries are correct — "pokemon tcg", "one piece card game" — but Walmart's search
 * answers a query for "card game" with every card game it sells, so the queries alone decide
 * nothing. A per-retailer rule is a rule that drifts; this one is shared deliberately.
 */

const { isTCGProduct } = require('./helpers');

const GAME_NAMES = ['pokemon', 'pokémon', 'one piece'];

/**
 * Set names count as naming the game, because retailers routinely drop the franchise word.
 *
 * Walmart lists the Prismatic Evolutions ETB — its own watchlist item, and the product behind
 * the biggest drop this monitor has covered — as "Scarlet & Violet—Prismatic Evolutions Elite
 * Trainer Box", with no "Pokemon" anywhere in it. Amazon's aria-labels do the same thing.
 * Requiring the franchise word alone would silently discard exactly the products that matter
 * most, so a recognised set name is accepted as equivalent evidence.
 *
 * These only ADD evidence; a match still has to clear isTCGProduct, so a board game or a
 * video game named after a set is still rejected.
 */
const SET_NAMES = [
  'scarlet & violet', 'scarlet and violet', 'sword & shield', 'sword and shield',
  'prismatic evolution', 'mega evolution', 'paldea', 'obsidian flames', 'paradox rift',
  'paradox clash', 'temporal forces', 'twilight masquerade', 'shrouded fable',
  'stellar crown', 'surging sparks', 'journey together', 'destined rivals',
  'white flare', 'black bolt', 'phantasmal flames', 'chaos rising', 'pitch black',
  'ascended heroes', 'perfect order', 'evolving skies', 'lost origin', 'silver tempest',
  'crown zenith', 'astral radiance', 'brilliant stars', 'fusion strike', 'vivid voltage',
  'celebrations', 'first partner', 'poke ball tin', 'pokeball tin',
];

// Accessories — never alert on these even if they name a game
const ACCESSORY_KEYWORDS = [
  'deck box', 'deckbox', 'playmat', 'play mat', 'sleeves', 'card sleeves',
  'penny sleeves', 'card protector', 'protector case', 'toploader', 'top loader',
  'display case', 'acrylic', 'portfolio', 'binder', 'card binder', 'album',
  'card holder', 'card organizer', 'storage box', 'card storage',
  'pet plastic', 'dice set', 'dice bag', 'coin holder', 'token box', 'token deck',
  'divider', 'accessories',
];

// Books ABOUT the hobby. They name a game and use card wording, so game+form alone lets them
// through, and most carry an ordinary product id rather than an ISBN.
const PRINT_KEYWORDS = [
  'investing', 'investor', 'for beginners', 'complete guide', 'collector guide',
  'character guide', 'price guide', 'value guide', 'collezionare', 'paperback', 'hardcover',
];

/**
 * Undo UTF-8 that was decoded as Latin-1: "Pokémon" arrives as "PokÃ©mon", "—" as "â€”".
 *
 * This has to run BEFORE any scope test. Two real Walmart products were stored as
 * "PokÃ©mon Trading Card Game: Sword & Shieldâ€”Evolving Skies", and "pokã©mon" contains
 * neither "pokemon" nor "pokémon" — so a scope filter added without this repair would have
 * deleted two legitimate Pokemon products as junk.
 *
 * Only touched when it actually looks like mojibake, and only kept if the round-trip
 * produces valid UTF-8, so a correctly-encoded name is never mangled.
 */
// The corruption is UTF-8 decoded as Windows-1252, NOT Latin-1, and the difference matters.
// Bytes 0x80-0x9F map to printable characters in cp1252 that sit above U+00FF, so a plain
// latin1 round-trip truncates them and destroys the name: the em dash in "Sword & Shield—
// Evolving Skies" arrives as "â" + "€"(U+20AC) + "”"(U+201D), and latin1 turns that into a
// replacement character instead of recovering it. Node has no cp1252 encoder, so this maps
// those characters back to their bytes explicitly.
const CP1252_TO_BYTE = new Map(Object.entries({
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A,
  '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C,
  'ž': 0x9E, 'Ÿ': 0x9F,
}));

function repairMojibake(str) {
  const s = String(str || '');
  if (!/Ã.|â€|Â./.test(s)) return s;

  const bytes = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xFF) bytes.push(cp);
    else if (CP1252_TO_BYTE.has(ch)) bytes.push(CP1252_TO_BYTE.get(ch));
    else return s; // not a cp1252 round-trip after all — leave it alone
  }

  try {
    const fixed = Buffer.from(bytes).toString('utf8');
    if (fixed.includes('�')) return s; // decode failed; the original is the safer answer
    return fixed;
  } catch {
    return s;
  }
}

/**
 * Everything tracked must name a game we follow, and must not be an accessory, a book, or a
 * sponsored ad slot. Names are mojibake-repaired first.
 */
function isInScopeName(name) {
  const repaired = repairMojibake(name);
  const lower = repaired.toLowerCase();
  if (!lower) return false;
  if (/^sponsored ad\b/.test(lower)) return false;
  if (ACCESSORY_KEYWORDS.some(k => lower.includes(k))) return false;
  if (PRINT_KEYWORDS.some(k => lower.includes(k))) return false;
  const namesGame = GAME_NAMES.some(g => lower.includes(g)) || SET_NAMES.some(k => lower.includes(k));
  if (!namesGame) return false;
  // Naming a game is not enough — it also has to BE a card product. Amazon always applied
  // this as a separate step and Walmart never did, which is how "Pokémon™ Violet (Nintendo
  // Switch)" and a shelf of UNO variants stayed in scope after the first cleanup.
  return isTCGProduct(repaired);
}

module.exports = {
  GAME_NAMES,
  SET_NAMES,
  ACCESSORY_KEYWORDS,
  PRINT_KEYWORDS,
  repairMojibake,
  isInScopeName,
};
