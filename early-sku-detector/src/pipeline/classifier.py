"""
Product classifier — determines if a product is TCG-related
and extracts metadata (brand, set name, product type).
"""
import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class Classification:
    is_tcg: bool
    brand: Optional[str] = None
    set_name: Optional[str] = None
    product_type: Optional[str] = None


# Known TCG brands and their identifiers
TCG_BRANDS = {
    "pokemon": ["pokemon", "pikachu", "charizard", "paldea", "scarlet", "violet",
                "obsidian", "prismatic", "surging", "twilight", "shrouded"],
    "one_piece": ["one piece card", "one piece tcg"],
    "yugioh": ["yu-gi-oh", "yugioh"],
    "magic": ["magic the gathering", "mtg"],
    "lorcana": ["lorcana", "disney lorcana"],
}

# Product types
PRODUCT_TYPES = {
    "booster_box": ["booster box", "booster display"],
    "etb": ["elite trainer box", "etb"],
    "collection": ["collection box", "collection"],
    "tin": ["collector tin", "tin"],
    "blister": ["blister pack", "blister", "sleeved booster"],
    "bundle": ["bundle", "build & battle"],
    "premium": ["premium collection", "ultra premium"],
    "binder": ["binder", "portfolio"],
}

# Negative signals — these are NOT TCG products
NON_TCG_SIGNALS = [
    "plush", "figure", "figurine", "toy", "costume", "backpack", "lunchbox",
    "bedding", "clothing", "shirt", "hat", "shoes", "socks", "pajama",
    "video game", "nintendo switch", "playstation", "xbox",
    "board game", "puzzle", "lego",
]


def classify(title: str, url: str = "") -> Classification:
    """Classify a product by title and URL."""
    if not title:
        # URL-only — check for TCG slug tokens
        text = url.lower()
    else:
        text = title.lower()

    # Check for non-TCG signals first
    for signal in NON_TCG_SIGNALS:
        if signal in text:
            return Classification(is_tcg=False)

    # Detect brand
    brand = None
    for brand_name, keywords in TCG_BRANDS.items():
        if any(kw in text for kw in keywords):
            brand = brand_name
            break

    if not brand:
        return Classification(is_tcg=False)

    # Detect product type
    product_type = None
    for type_name, keywords in PRODUCT_TYPES.items():
        if any(kw in text for kw in keywords):
            product_type = type_name
            break

    # Extract set name (best effort — between brand and product type)
    set_name = _extract_set_name(text, brand)

    return Classification(
        is_tcg=True,
        brand=brand,
        set_name=set_name,
        product_type=product_type,
    )


def _extract_set_name(text: str, brand: str) -> Optional[str]:
    """Try to extract the set/expansion name from the title."""
    # Common Pokemon set patterns
    pokemon_sets = [
        "prismatic evolutions", "surging sparks", "twilight masquerade",
        "shrouded fable", "stellar crown", "paldea evolved",
        "obsidian flames", "scarlet & violet", "paradox rift",
        "temporal forces", "mask of change", "journey together",
        "destined rivals",
    ]

    for set_name in pokemon_sets:
        if set_name in text:
            return set_name.title()

    return None
