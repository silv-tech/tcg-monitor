"""
Product state machine — manages state transitions and event logging.

States: DISCOVERED → LISTED → PRICED → PREORDER → IN_STOCK → OOS
Can skip forward, never backward.
"""
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models import Product, SkuEvent, VALID_TRANSITIONS, SOURCE_SITEMAP, SOURCE_UPC, SOURCE_SKU_RANGE

logger = logging.getLogger(__name__)

SOURCE_FLAG_MAP = {
    "sitemap": SOURCE_SITEMAP,
    "upc": SOURCE_UPC,
    "sku_range": SOURCE_SKU_RANGE,
}


async def upsert_product(
    session: AsyncSession,
    sku: str,
    source: str,
    *,
    url: Optional[str] = None,
    title: Optional[str] = None,
    brand: Optional[str] = None,
    set_name: Optional[str] = None,
    product_type: Optional[str] = None,
    upc: Optional[str] = None,
    msrp: Optional[float] = None,
    current_price: Optional[float] = None,
    seller_type: Optional[str] = None,
    in_stock: bool = False,
) -> tuple[Product, Optional[str]]:
    """
    Insert or update a product. Returns (product, new_state_or_None).
    new_state is set only if a state transition occurred.
    """
    now = datetime.now(timezone.utc)
    source_flag = SOURCE_FLAG_MAP.get(source, 0)

    # Fetch existing product
    result = await session.execute(select(Product).where(Product.sku == sku))
    product = result.scalar_one_or_none()

    if product is None:
        # New product
        product = Product(
            sku=sku,
            upc=upc,
            title=title,
            brand=brand,
            set_name=set_name,
            product_type=product_type,
            msrp=Decimal(str(msrp)) if msrp else None,
            current_price=Decimal(str(current_price)) if current_price else None,
            seller_type=seller_type,
            state="DISCOVERED",
            confidence=Decimal("0.0"),
            source_flags=source_flag,
            first_seen_at=now,
        )
        session.add(product)
        await session.flush()

        # Log the event
        event = SkuEvent(
            sku=sku,
            from_state=None,
            to_state="DISCOVERED",
            source=source,
            evidence={"url": url} if url else {},
            observed_at=now,
        )
        session.add(event)
        await session.flush()

        logger.info(f"NEW product {sku} via {source}")
        return product, "DISCOVERED"

    # Existing product — update fields if new data available
    if title and not product.title:
        product.title = title
    if brand and not product.brand:
        product.brand = brand
    if set_name and not product.set_name:
        product.set_name = set_name
    if upc and not product.upc:
        product.upc = upc
    if current_price:
        product.current_price = Decimal(str(current_price))
    if msrp and not product.msrp:
        product.msrp = Decimal(str(msrp))
    if seller_type:
        product.seller_type = seller_type

    # Merge source flags
    product.source_flags |= source_flag
    product.updated_at = now

    # Determine new state based on available data
    new_state = _determine_state(product, in_stock, current_price)
    old_state = product.state
    transitioned = None

    if new_state and new_state != old_state:
        if new_state in VALID_TRANSITIONS.get(old_state, set()):
            product.state = new_state
            transitioned = new_state

            # Set milestone timestamps
            if new_state == "PRICED" and not product.first_priced_at:
                product.first_priced_at = now
            elif new_state in ("PREORDER", "IN_STOCK") and not product.first_buyable_at:
                product.first_buyable_at = now

            event = SkuEvent(
                sku=sku,
                from_state=old_state,
                to_state=new_state,
                source=source,
                evidence={"url": url, "price": current_price} if url else {},
                observed_at=now,
            )
            session.add(event)

            logger.info(f"State transition {sku}: {old_state} → {new_state} via {source}")

    await session.flush()
    return product, transitioned


def _determine_state(
    product: Product, in_stock: bool, price: Optional[float]
) -> Optional[str]:
    """Determine what state the product should be in based on signals."""
    if in_stock:
        return "IN_STOCK"
    if price and price > 0:
        return "PRICED"
    if product.title:
        return "LISTED"
    return None
