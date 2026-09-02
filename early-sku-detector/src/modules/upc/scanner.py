"""
UPC/GTIN database scanner.

Polls UPCitemdb.com for new entries with known TCG publisher prefixes.
Pokemon Company International UPCs start with 820650.

New UPCs → lookup on Walmart/Amazon → feed into pipeline.
"""
import json
import logging
import re
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.db.models import ScannedId
from src.fetch.client import fetch_client
from src.modules.base import DiscoveredProduct, RetailerModule

logger = logging.getLogger(__name__)

# UPC prefixes for TCG publishers
UPC_PREFIXES = {
    "820650": "pokemon",     # The Pokemon Company International
    "083717": "yugioh",      # Konami
    "630509": "hasbro",      # Hasbro (MTG, some Pokemon)
    "195166": "bandai",      # Bandai (One Piece, Digimon)
}

# UPCitemdb.com lookup (free tier: 100 requests/day)
UPCITEMDB_API = "https://api.upcitemdb.com/prod/trial/lookup"


class UPCScannerModule(RetailerModule):
    retailer_name = "upc_database"

    async def run(self, session: AsyncSession) -> list[DiscoveredProduct]:
        """
        1. Generate candidate UPCs from known prefixes
        2. Skip already-scanned IDs
        3. Lookup via UPCitemdb
        4. Return matches as discovered products
        """
        products = []
        candidates = await self._get_candidates(session)

        if not candidates:
            logger.info("No new UPC candidates to scan")
            return products

        logger.info(f"Scanning {len(candidates)} UPC candidates")

        for upc in candidates:
            result = await self._lookup_upc(upc)
            if result:
                products.append(result)

            # Record scan regardless of result
            scanned = ScannedId(
                id=upc,
                hit=result is not None,
                anchor_sku=None,
                scanned_at=None,  # uses default
            )
            session.add(scanned)

        await session.flush()
        logger.info(f"UPC scan complete: {len(products)} hits from {len(candidates)} candidates")
        return products

    async def _get_candidates(self, session: AsyncSession) -> list[str]:
        """Generate UPC candidates that haven't been scanned yet."""
        # Get already scanned UPCs
        result = await session.execute(
            select(ScannedId.id).where(ScannedId.id.like("8206%"))
        )
        scanned = {row[0] for row in result.all()}

        # Generate candidates from the Pokemon prefix range
        # Pokemon UPCs: 820650XXXXXX (12 digits)
        # We scan a window around known products
        candidates = []
        prefix = "820650"

        # Scan latest ranges (high product IDs = newer products)
        # This is a simplified approach — real implementation would
        # track the frontier and expand from there
        for suffix in range(200000, 200000 + settings.upc_batch_size):
            upc = f"{prefix}{suffix:06d}"
            if upc not in scanned:
                candidates.append(upc)

        return candidates[:settings.upc_batch_size]

    async def _lookup_upc(self, upc: str) -> Optional[DiscoveredProduct]:
        """Look up a UPC on UPCitemdb.com."""
        url = f"{UPCITEMDB_API}?upc={upc}"
        body = await fetch_client.get(url)
        if not body:
            return None

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return None

        items = data.get("items", [])
        if not items:
            return None

        item = items[0]
        title = item.get("title", "")
        brand = item.get("brand", "")

        # Determine which prefix this is
        prefix = upc[:6]
        source_brand = UPC_PREFIXES.get(prefix, "unknown")

        return DiscoveredProduct(
            sku=upc,  # UPC as initial SKU — will be mapped to retailer SKU later
            source="upc",
            retailer="upc_database",
            title=title,
            brand=source_brand,
            upc=upc,
            evidence={
                "upcitemdb": item,
                "brand_raw": brand,
            },
        )
