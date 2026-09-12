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
  // Pokémon's 30th-anniversary line (2026). Added because Amazon's search tiles drop the
  // accented "Pokémon" prefix ("Pokémon TCG: 30th Celebration ETB" -> "TCG: 30th Celebration
  // ETB"), and without a set-name match the game-name gate then rejects it — which is exactly
  // why B0H7818RCM / B0H78BB9TY / B0H77W4411 were missed. These phrases are specific to the
  // anniversary line, so they establish Pokémon scope without over-matching. "celebrations"
  // (the 2021 set) is deliberately kept separate — it does not contain "30th".
  '30th celebration', '30th anniversary',

  // The middle of Sword & Shield was simply skipped. The list ran from Vivid Voltage to Crown
  // Zenith and from Scarlet & Violet forward, leaving six real sets with no entry — so a booster
  // box titled by its set alone, with no franchise word, failed the game-name gate and was
  // dropped. Measured 2026-09-11: adding these recovers 33 stored rows at one retailer, 29 of them
  // in stock, including a $859 Rebel Clash booster box and a $4,389 Darkness Ablaze sealed case.
  'rebel clash', 'darkness ablaze', "champion's path", 'champions path',
  'shining fates', 'battle styles', 'chilling reign',

  // The 151 special set, anchored to sealed forms ON PURPOSE. A bare '151' would match a
  // "151-piece jigsaw puzzle" and a "151-count storage box", which is exactly the kind of
  // over-match that makes a scope rule untrustworthy. These phrases cannot.
  '151 blooming waters', '151 booster', '151 elite trainer', '151 ultra premium',
  '151 collection', '151 pin collection', '151 poster collection',

  // One Piece OP-17, shipping now. Every One Piece row until this depended on the literal string
  // "one piece" appearing, so a product titled only by its set name was invisible.
  "the world's strongest warriors", 'the worlds strongest warriors',

  // 2025 tin line that names neither a set nor the franchise.
  'slashing legends',
];

/**
 * Franchises we do not follow, named distinctively enough that no Pokemon or One Piece title
 * contains one by accident.
 *
 * This exists because a SET name is accepted as proof of the game, so any title carrying BOTH a
 * foreign franchise and one of our set names slipped through. Measured across 86,709 stored rows:
 * three did, all admitted purely by "30th anniversary" — an entry added for Pokemon's own 30th line
 * — on a Weiss Schwarz and a Cardfight!! Vanguard "Persona 30th Anniversary Booster Box". The same
 * measurement found ZERO legitimate products this veto would reject.
 *
 * Multi-word phrases only, deliberately. A bare "magic" or "vanguard" collides with ordinary
 * English on a real Pokemon title; these cannot. Dragon Ball is absent on purpose — Titan Toyz is
 * granted it via extraGameNames, and a retailer's granted franchise is never vetoed.
 */
const FOREIGN_GAMES = [
  'yu-gi-oh', 'yugioh', 'yu gi oh',
  'magic: the gathering', 'magic the gathering',
  'star wars unlimited', 'lorcana', 'digimon card', 'union arena',
  'weiss schwarz', 'flesh and blood', 'grand archive', 'riftbound',
  'my little pony', 'palworld', 'cardfight', 'battle spirits', 'shadowverse',
  'metazoo', 'sorcery: contested', 'alpha clash', 'gundam card',
];

/**
 * Admission to an EVENT, not a thing in a box.
 *
 * These read as sealed product and passed every gate: gameshack lists "One Piece Two Legends OP-08
 * Pre-Release Sealed Event Ticket September 8, 12:45 PM" — the word "Sealed" is right there — and
 * kanzengames lists "Pokemon TCG Event League Challenge - Friday Oct 2nd @ 6:30 PM". Measured
 * 2026-09-11: 11 such rows were in scope, 8 of them in stock, priced $10-$60. Alerting one tells a
 * customer to buy something that arrives as a seat at a table, not a product.
 *
 * PHRASES, not bare words. A bare "ticket" would reject a real "Golden Ticket Promo Collection Box",
 * and a bare "entry" or "seat" is worse still. Every phrase here needs the event sense to match.
 */
const EVENT_KEYWORDS = [
  'event ticket', 'league challenge', 'league cup', 'prerelease event', 'pre-release event',
  'tournament entry', 'entry fee', 'tournament ticket', 'event pass',
];

// Unambiguous sealed product types. No accessory is named any of these, so their presence
// settles the question when a title also happens to contain an accessory word.
// Sealed product forms. Everything here ships booster packs inside a factory-sealed box, so
// it is product a restock watcher cares about — not an accessory.
//
// The second line was added after Pokemon Center adopted this shared rule: pin collections,
// poster collections, sticker collections and the holiday/advent calendars were all being
// dropped as out-of-scope, which is a FALSE NEGATIVE — the silent kind that shows up as an
// alert that never fires rather than a wrong one that does. Every one of them is a sealed box
// containing packs and a promo card, and 'poster-collection' was already in Pokemon Center's
// own keyword list, so the store had always intended to track them.
const DEFINITE_SEALED = /(elite trainer box|booster box|booster bundle|booster pack|booster display|build\s*[&and]+\s*battle|premium collection|ultra premium collection|collection box|battle deck|starter deck|structure deck|mini tin|booster tin|checklane)/i;
const SEALED_COLLECTION_FORMS = /(pin collection|poster collection|sticker collection|special collection|(?:holiday|advent) calendar)/i;

/**
 * Merchandise that names a game but is not a trading card product at all.
 *
 * Checked EARLY, before the sealed-form shortcut, because these carry sealed-sounding wording:
 * "Pokemon Plamo Collection 64 Select Series Mega Dragonite" reads as a collection, and Plamo
 * is Bandai's plastic model line. Nine such products were in scope across the shops, and the
 * $15 alert floor was the only thing keeping most of them quiet — the pokejeux Plamo kit at
 * $41.99 was above it and would have alerted.
 *
 * "Playing cards" is a poker deck, not a TCG product, however much the words overlap.
 */
const NON_TCG_MERCH = [
  'plamo', 'model kit', 'plastic model', 'figure kit',
  'playing cards', 'poker', 'jigsaw',
  // A Toniebox is an audio player. It rode in because TCG_KEYWORDS contains 'box ', which
  // matches inside "toniebox 2" — so "Tonies Pokemon Toniebox 2 Starter Set Lightning Yellow"
  // scored as sealed Pokemon product and was, on 2026-09-11, the ONE in-stock row Costco had.
  // A $239.99 audio player is what would have alerted the moment that store recovered.
  // tests/costco-scope.test.js already listed it as must-reject: the local filter it replaced
  // caught it, the shared rule did not, and nothing noticed because the store was dark.
  'tonie',
];

// Accessories — never alert on these even if they name a game
const ACCESSORY_KEYWORDS = [
  'deck box', 'deckbox', 'playmat', 'play mat', 'sleeves', 'card sleeves',
  'penny sleeves', 'card protector', 'protector case', 'toploader', 'top loader',
  'display case', 'acrylic', 'portfolio', 'binder', 'card binder', 'album',
  'card holder', 'card organizer', 'storage box', 'card storage',
  'pet plastic', 'dice set', 'dice bag', 'coin holder', 'token box', 'token deck',
  'divider', 'accessories', 'card book', 'trading card book',
  // Play accessories sold as boxed "sets", which is close enough to sealed product wording to
  // get through on game-name plus form. Found by the Pokemon Center category sweep: these four
  // were the only in-scope products it ever reported in stock, and all four were dice.
  'damage counter', 'condition marker', 'counter dice', 'dice and condition',
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

/**
 * Collapse runs of whitespace so a typo cannot defeat a literal match.
 *
 * Found at doescards on a real $449.99 bundle titled "One  Piece" with two spaces: every scope
 * check here is an `.includes()` against a single-spaced phrase, so the product named its own
 * franchise and was still rejected. Normalising costs nothing and closes the whole class.
 */
function collapseSpaces(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

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
 * A SINGLE card, as opposed to a sealed product.
 *
 * The big seven only sell sealed, so this never came up there. The card shops are the
 * opposite: of 80,861 stored shop products, ~79,000 were singles, other games or non-TCG
 * stock, and they were the bulk of what reached Discord (97% of #infinitycards alerts).
 *
 * A single is identified by its own card code sitting near the START of the title —
 * "EEVEE ex (174) - ...", "Hoothoot (TG12) - ...", "Zacian V (SWSH292) - ..." — or by a
 * grade or condition anywhere in it.
 *
 * Nothing later in the title may override that. Singles are routinely named after the sealed
 * product they were pulled from ("Eevee (173) - Prismatic Evolutions Pokemon Center ETB"),
 * so an earlier attempt that rescued anything containing sealed wording reinstated 137 of the
 * exact rows it was meant to remove. Validated against all 3,276 in-scope shop products:
 * 1,635 dropped, every one a single; 1,641 kept, every one sealed.
 */
// Also matches a hyphenated set-and-number code — "(ST22-010)", "(EB03-034)", "(OP09-001)" —
// which One Piece singles use, and which may be followed by "[Set Name]" rather than " - ".
const CARD_CODE = '(?:[A-Z]{0,5}\\d{1,4}[A-Za-z]?|\\d{1,3}\\/\\d{1,3}|[A-Z]{1,4}\\d{1,3}-\\d{1,3})';
// "<name> (CODE) - <rest>" — the rest may name a sealed form, so it gets the rescue below.
const CODE_THEN_DASH = new RegExp(`^(?:.{0,70}?)\\(${CARD_CODE}\\)\\s*[-–]\\s*(.*)$`);
// "<name> (CODE) [Set Name]" — bracketed text is always the SET a single came from, never a
// product form. "Portgas.D.Ace (Parallel) (ST22-010) [Starter Deck 22]" is a card, and
// rescuing on the words "Starter Deck" inside those brackets put it straight back.
const CODE_THEN_BRACKET = new RegExp(`^(?:.{0,70}?)\\(${CARD_CODE}\\)\\s*\\[`);

/**
 * A set code can look exactly like a card code, so the word straight after it decides.
 * "Japanese Pokemon Triple Beat EX (SV1a) - Booster" is a sealed booster and (SV1a) is the
 * SET; "Eevee (173) - Prismatic Evolutions Pokemon Center ETB" is a card and (173) is its
 * number. The difference is that the sealed one names its FORM immediately after the code.
 *
 * Deliberately anchored to the start of that remainder. Matching sealed wording anywhere in
 * the title is what wrongly rescued 137 singles named after the box they came from.
 */
const SEALED_FORM_START = /^(?:booster|elite trainer|etb|starter deck|premium collection|collection box|build\s*[&and]+\s*battle|display|case|bundle|blister|tin|box|pack)\b/i;

const SINGLE_CARD_MARKERS = [
  /\bPSA\s?\d/i, /\bCGC\s?\d/i, /\bBGS\s?\d/i,
  /\b(?:near mint|lightly played|moderately played|heavily played|damaged)\b/i,
  /\s[-–]\s(?:NM|LP|MP|HP|SP|DMG)(?:\s|$)/,
  /\b\d{3}\/\d{3}\b/,
  /\s[-–]\s\d{1,3}\/\d{1,3}(?:\s|$)/,

  // One Piece promo singles. These were being alerted as sealed product.
  //
  // The trap here is that the pack names are shared with real products: "Winner Pack",
  // "Event Pack" and "Premium Card Collection" each name BOTH a sealed item and the singles
  // pulled from it. Excluding on the pack name would have destroyed genuine product —
  // "One Piece Winner Pack Vol. 7 (Law Cover)" and "Premium Card Collection - Best Selection
  // Vol 7" are things a customer wants alerted.
  //
  // So these match only wording that a sealed box never carries:
  //   "One Piece Promotion Cards"  — plural CARDS, i.e. the cards, not the box
  //   "(P-019)"                    — the parenthesised One Piece promo card number. Sealed
  //                                  items that cite a promo code bracket it instead
  //                                  ("One Piece Day 2026 [P-161] ... Premium Card Collection").
  //   "NM-Mint" / "Slightly Played" — condition grades. Nothing factory-sealed is graded.
  // Verified against 3,386 live in-scope products and 7,500 hobbiesville listings: 101 singles
  // removed, and every sealed product above still kept.
  // PLURAL ONLY. The `s?` here matched the SINGULAR too, which is precisely how a sealed box
  // describes its own contents ("...2 Booster Packs, Promotion Card and Coin"), so three genuine
  // sealed products were deleted from the Amazon catalogue on EVERY poll, continuously:
  // B0GSC9654K and B0GSCJ3V5C (Ascended Heroes blisters) and B0GTRFRHW3 (Mega Zygarde-ex Premium
  // Collection). They never reached Redis — `_buildFromSearch` re-admitted them each poll on the
  // looser hasGameScope/isTCGProduct pair and the scope purge deleted them again — so they could
  // never diff and never alert. Measured live 2026-09-12, firing every 30-90s for hours.
  //
  // Making it plural-only is not a new heuristic; it is what the contract three lines above
  // already specifies ("plural CARDS, i.e. the cards, not the box"). Note also that isSingleCard
  // runs BEFORE the DEFINITE_SEALED shortcut, so two of those three matched a definite sealed form
  // and never got to say so — the ordering gives this marker no second chance to be wrong.
  /\bpromotion(?:al)? cards\b/i,
  /\(P-\d{2,4}\)/,
  /\b(?:NM|LP|MP|HP|SP)-(?:mint|near ?mint|lightly played|played)\b/i,
  /\bslightly played\b/i,
];

function isSingleCard(name) {
  const s = collapseSpaces(repairMojibake(name));
  if (CODE_THEN_BRACKET.test(s)) return true;
  const m = s.match(CODE_THEN_DASH);
  if (m && !SEALED_FORM_START.test(m[1].trim())) return true;
  return SINGLE_CARD_MARKERS.some(re => re.test(s));
}

/**
 * Everything tracked must name a game we follow, and must not be an accessory, a book, a
 * sponsored ad slot, or a single card. Names are mojibake-repaired first.
 */
function isInScopeName(name, extraGameNames = []) {
  const repaired = collapseSpaces(repairMojibake(name));
  const lower = repaired.toLowerCase();
  if (!lower) return false;
  if (/^sponsored ad/.test(lower)) return false;
  if (PRINT_KEYWORDS.some(k => lower.includes(k))) return false;
  if (NON_TCG_MERCH.some(k => lower.includes(k))) return false;
  if (EVENT_KEYWORDS.some(k => lower.includes(k))) return false;

  // Checked BEFORE the sealed shortcut below, so a single named after the box it came from
  // is still rejected ("Eevee (173) - Prismatic Evolutions Pokemon Center ETB - Promo").
  if (isSingleCard(repaired)) return false;

  // A franchise we do not follow, UNLESS this retailer is explicitly granted it. Checked before
  // the game-name gate because a set name alone is enough to pass that gate, which is how three
  // foreign booster boxes rode in on "30th anniversary".
  const granted = extraGameNames.some(g => lower.includes(String(g).toLowerCase()));
  if (!granted && FOREIGN_GAMES.some(g => lower.includes(g))) return false;

  const namesGame = GAME_NAMES.some(g => lower.includes(g)) || SET_NAMES.some(k => lower.includes(k))
    || extraGameNames.some(g => lower.includes(g)); // per-retailer additive scope (default none)
  if (!namesGame) return false;

  // An unambiguous sealed product type settles it. Sealed boxes describe their own contents,
  // and the word "accessories" was vetoing real ones TWICE over — once via ACCESSORY_KEYWORDS
  // here and again via the accessory entries inside isTCGProduct. Best Buy's "Scarlet & Violet
  // (SV7) Stellar Crown Elite Trainer Box 9 packs & accessories" is an ETB, not an accessory.
  if (DEFINITE_SEALED.test(repaired)) return true;
  if (SEALED_COLLECTION_FORMS.test(repaired)) return true;

  if (ACCESSORY_KEYWORDS.some(k => lower.includes(k))) return false;

  // "Bundle Deal" is a sealed form, but it is checked HERE rather than in DEFINITE_SEALED above,
  // and the position is the whole point. DEFINITE_SEALED returns true BEFORE the accessory veto
  // (deliberately, so an "ETB ... 9 packs & accessories" is not vetoed), so folding this in there
  // would admit any accessory bundle titled "bundle deal" — a sleeves-and-deck-box set would sail
  // through. An earlier attempt did exactly that. After the veto, it cannot.
  //
  // Recovers two real products, the most expensive rows in the catalogue: kanzengames' "Mega
  // Evolution Set 7 ME07 Bundle Deal" and its Wave 2 variant, $399.95 each.
  if (/\bbundle deal\b/i.test(repaired)) return true;
  // Naming a game is not enough — it also has to BE a card product. Amazon always applied
  // this as a separate step and Walmart never did, which is how "Pokémon™ Violet (Nintendo
  // Switch)" and a shelf of UNO variants stayed in scope after the first cleanup.
  return isTCGProduct(repaired);
}


/**
 * Sealed product FORMS, as a list rather than a pattern.
 *
 * DEFINITE_SEALED above answers "is this one name sealed product?". This answers a different
 * question — "are these two names the same KIND of product?" — which cross-retailer matching
 * needs, because a Booster Bundle and a Booster Box of the same set share almost every word.
 * Kept deliberately separate from DEFINITE_SEALED: that regex decides what enters the system
 * at all, and widening it to serve a display feature would change scope for every retailer.
 */
const PRODUCT_FORMS = [
  'elite trainer box', 'booster box', 'booster bundle', 'booster pack', 'booster display',
  'build & battle', 'build and battle', 'premium collection', 'ultra premium collection',
  'collection box', 'battle deck', 'starter deck', 'structure deck', 'mini tin', 'booster tin',
  'checklane', 'ex box', 'surprise box', 'triple pack', 'blister', 'poster collection',
  'pin collection', 'sticker collection',
];

module.exports = {
  GAME_NAMES,
  SET_NAMES,
  PRODUCT_FORMS,
  ACCESSORY_KEYWORDS,
  PRINT_KEYWORDS,
  repairMojibake,
  collapseSpaces,
  isSingleCard,
  isInScopeName,
};
