"""
Product filter — rejects non-TCG products and logs rejections.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models import FilterRejection
from src.modules.base import DiscoveredProduct
from src.pipeline.classifier import classify

logger = logging.getLogger(__name__)


async def filter_product(
    product: DiscoveredProduct, session: AsyncSession
) -> bool:
    """
    Returns True if product should be kept, False if rejected.
    Logs rejections to DB for review.
    """
    classification = classify(product.title or "", product.url or "")

    if not classification.is_tcg:
        reason = "not_tcg"
        if not product.title and not product.url:
            reason = "no_data"

        rejection = FilterRejection(
            sku=product.sku,
            title=product.title,
            reason=reason,
            raw_data={
                "url": product.url,
                "source": product.source,
                "retailer": product.retailer,
            },
            rejected_at=datetime.now(timezone.utc),
        )
        session.add(rejection)

        logger.debug(f"Rejected {product.sku}: {reason} (title={product.title!r})")
        return False

    # Enrich product with classification data
    if classification.brand and not product.brand:
        product.brand = classification.brand
    if classification.set_name and not product.set_name:
        product.set_name = classification.set_name
    if classification.product_type and not product.product_type:
        product.product_type = classification.product_type

    return True
