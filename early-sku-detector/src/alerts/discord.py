"""
Discord webhook alerts for early SKU detections.
"""
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

from src.config import settings
from src.db.models import Product
from src.modules.base import DiscoveredProduct
from src.pipeline.scorer import count_sources

logger = logging.getLogger(__name__)

# Colors for different states
STATE_COLORS = {
    "DISCOVERED": 0x3498DB,   # Blue — just found
    "LISTED": 0xF39C12,       # Orange — has title
    "PRICED": 0xE67E22,       # Dark orange — has price
    "PREORDER": 0x9B59B6,     # Purple — preorder available
    "IN_STOCK": 0x2ECC71,     # Green — buyable
    "OOS": 0x95A5A6,          # Gray — out of stock
}

SOURCE_LABELS = {
    "sitemap": "Sitemap Diff",
    "upc": "UPC Database",
    "sku_range": "SKU Range Scan",
}


async def send_alert(
    product: Product,
    new_state: str,
    discovery: DiscoveredProduct,
) -> bool:
    """Send a Discord webhook embed for a product state transition."""
    if not settings.discord_webhook_url:
        logger.debug("No Discord webhook configured, skipping alert")
        return False

    embed = _build_embed(product, new_state, discovery)

    payload = {
        "username": "Early SKU Detector",
        "embeds": [embed],
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10)) as client:
            resp = await client.post(settings.discord_webhook_url, json=payload)
            if resp.status_code in (200, 204):
                logger.info(f"Alert sent for {product.sku} → {new_state}")
                return True
            else:
                logger.error(f"Discord webhook failed: {resp.status_code} {resp.text}")
                return False
    except Exception as e:
        logger.error(f"Discord webhook error: {e}")
        return False


def _build_embed(
    product: Product,
    new_state: str,
    discovery: DiscoveredProduct,
) -> dict:
    """Build a Discord embed for a product alert."""
    color = STATE_COLORS.get(new_state, 0x95A5A6)
    source_label = SOURCE_LABELS.get(discovery.source, discovery.source)
    sources_count = count_sources(product.source_flags)

    title = product.title or f"SKU {product.sku}"
    if len(title) > 256:
        title = title[:253] + "..."

    fields = [
        {"name": "SKU", "value": f"`{product.sku}`", "inline": True},
        {"name": "State", "value": new_state, "inline": True},
        {"name": "Source", "value": source_label, "inline": True},
    ]

    if product.upc:
        fields.append({"name": "UPC", "value": f"`{product.upc}`", "inline": True})

    if product.brand:
        fields.append({"name": "Brand", "value": product.brand.title(), "inline": True})

    if product.set_name:
        fields.append({"name": "Set", "value": product.set_name, "inline": True})

    if product.product_type:
        fields.append({"name": "Type", "value": product.product_type.replace("_", " ").title(), "inline": True})

    if product.current_price:
        fields.append({"name": "Price", "value": f"${product.current_price} CAD", "inline": True})

    if product.msrp:
        fields.append({"name": "MSRP", "value": f"${product.msrp} CAD", "inline": True})

    fields.append({
        "name": "Confidence",
        "value": f"{float(product.confidence) * 100:.0f}% ({sources_count} source{'s' if sources_count != 1 else ''})",
        "inline": True,
    })

    if discovery.url:
        fields.append({"name": "URL", "value": discovery.url, "inline": False})

    # Timestamps
    first_seen = product.first_seen_at.strftime("%Y-%m-%d %H:%M UTC")
    fields.append({"name": "First Seen", "value": first_seen, "inline": True})

    if product.first_priced_at:
        fields.append({
            "name": "First Priced",
            "value": product.first_priced_at.strftime("%Y-%m-%d %H:%M UTC"),
            "inline": True,
        })

    embed = {
        "title": title,
        "color": color,
        "fields": fields,
        "footer": {"text": f"Early SKU Detector · {discovery.retailer}"},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    return embed
