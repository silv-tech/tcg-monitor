"""
Main pipeline processor — takes discovered products from any module,
runs them through filter → state machine → scorer → alert.
"""
import logging
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.base import DiscoveredProduct
from src.pipeline.filter import filter_product
from src.pipeline.state_machine import upsert_product
from src.pipeline.scorer import compute_confidence
from src.alerts.discord import send_alert
from src.db.models import Product

logger = logging.getLogger(__name__)


async def process_discoveries(
    products: list[DiscoveredProduct],
    session: AsyncSession,
) -> dict:
    """
    Process a batch of discovered products through the full pipeline.
    Returns stats dict: {new, updated, filtered, errors, alerts_sent}
    """
    stats = {"new": 0, "updated": 0, "filtered": 0, "errors": 0, "alerts_sent": 0}

    for disc in products:
        try:
            # Step 1: Filter
            keep = await filter_product(disc, session)
            if not keep:
                stats["filtered"] += 1
                continue

            # Step 2: Upsert into state machine
            product, new_state = await upsert_product(
                session,
                sku=disc.sku,
                source=disc.source,
                url=disc.url,
                title=disc.title,
                brand=disc.brand,
                set_name=disc.set_name,
                product_type=disc.product_type,
                upc=disc.upc,
                msrp=disc.msrp,
                current_price=disc.current_price,
                seller_type=disc.seller_type,
                in_stock=disc.in_stock,
            )

            # Step 3: Update confidence score
            new_confidence = compute_confidence(product.source_flags)
            if new_confidence != product.confidence:
                product.confidence = new_confidence

            if new_state == "DISCOVERED":
                stats["new"] += 1
            elif new_state:
                stats["updated"] += 1

            # Step 4: Alert on significant state transitions
            if new_state in ("DISCOVERED", "PRICED", "IN_STOCK"):
                await send_alert(product, new_state, disc)
                stats["alerts_sent"] += 1

        except Exception as e:
            logger.error(f"Error processing {disc.sku}: {e}", exc_info=True)
            stats["errors"] += 1

    await session.commit()

    logger.info(
        f"Pipeline complete: {stats['new']} new, {stats['updated']} updated, "
        f"{stats['filtered']} filtered, {stats['alerts_sent']} alerts, "
        f"{stats['errors']} errors"
    )
    return stats
