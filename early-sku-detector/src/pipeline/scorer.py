"""
Confidence scorer — assigns confidence based on how many sources
have independently confirmed a product.
"""
from decimal import Decimal

from src.config import settings
from src.db.models import SOURCE_SITEMAP, SOURCE_UPC, SOURCE_SKU_RANGE


def count_sources(source_flags: int) -> int:
    """Count how many distinct sources have confirmed this product."""
    count = 0
    if source_flags & SOURCE_SITEMAP:
        count += 1
    if source_flags & SOURCE_UPC:
        count += 1
    if source_flags & SOURCE_SKU_RANGE:
        count += 1
    return count


def compute_confidence(source_flags: int) -> Decimal:
    """Compute confidence score based on number of confirming sources."""
    n = count_sources(source_flags)
    if n >= 3:
        return Decimal(str(settings.confidence_three_sources))
    elif n >= 2:
        return Decimal(str(settings.confidence_two_sources))
    elif n >= 1:
        return Decimal(str(settings.confidence_single_source))
    return Decimal("0.0")
