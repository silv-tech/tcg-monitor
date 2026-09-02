"""
SKU range scanner.

Given a known product SKU (anchor), scans nearby SKU IDs (±N)
to discover sibling products that were uploaded in the same batch.

Retailers often assign sequential IDs, so products uploaded together
have nearby SKUs. This lets us find unreleased products.
"""
import json
import logging
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.db.models import Product, ScannedId
from src.fetch.client import fetch_client
from src.modules.base import DiscoveredProduct, RetailerModule

logger = logging.getLogger(__name__)

# Walmart product page URL template
WALMART_PRODUCT_URL = "https://www.walmart.ca/en/ip/{sku}"


class SKURangeScannerModule(RetailerModule):
    retailer_name = "walmart_ca"

    async def run(self, session: AsyncSession) -> list[DiscoveredProduct]:
        """
        1. Find anchor SKUs (known products)
        2. For each anchor, scan ±window of nearby SKUs
        3. Check each SKU on Walmart
        4. Return hits as discovered products
        """
        anchors = await self._get_anchors(session)
        if not anchors:
            logger.info("No anchor SKUs available for range scanning")
            return []

        all_products = []
        for anchor_sku in anchors:
            products = await self._scan_range(anchor_sku, session)
            all_products.extend(products)

        logger.info(f"SKU range scan complete: {len(all_products)} discoveries from {len(anchors)} anchors")
        return all_products

    async def _get_anchors(self, session: AsyncSession) -> list[str]:
        """Get known product SKUs to use as scan anchors."""
        result = await session.execute(
            select(Product.sku)
            .where(
                Product.sku.regexp_match(r"^\d{10,13}$"),  # Numeric SKUs only
                Product.state != "OOS",
            )
            .order_by(Product.first_seen_at.desc())
            .limit(10)
        )
        return [row[0] for row in result.all()]

    async def _scan_range(
        self, anchor_sku: str, session: AsyncSession
    ) -> list[DiscoveredProduct]:
        """Scan ±window around an anchor SKU."""
        try:
            anchor_num = int(anchor_sku)
        except ValueError:
            return []

        window = settings.sku_range_window
        products = []
        hits = 0
        checks = 0

        # Get already-scanned IDs for this anchor
        result = await session.execute(
            select(ScannedId.id).where(ScannedId.anchor_sku == anchor_sku)
        )
        already_scanned = {row[0] for row in result.all()}

        # Scan forward and backward from anchor
        for offset in range(-window, window + 1):
            if offset == 0:
                continue

            candidate = str(anchor_num + offset)
            if candidate in already_scanned:
                continue

            checks += 1
            product = await self._check_sku(candidate)

            scanned = ScannedId(
                id=candidate,
                hit=product is not None,
                anchor_sku=anchor_sku,
            )
            session.add(scanned)

            if product:
                hits += 1
                products.append(product)

            # Adaptive expansion — stop if hit density too low
            if checks >= 50 and hits / checks < settings.sku_range_hit_threshold:
                logger.info(
                    f"Stopping range scan from {anchor_sku}: "
                    f"density {hits}/{checks} = {hits/checks:.3f} < {settings.sku_range_hit_threshold}"
                )
                break

            # Hard cap
            if checks >= settings.sku_range_max_window:
                break

        await session.flush()
        logger.info(f"Range scan from {anchor_sku}: {hits} hits in {checks} checks")
        return products

    async def _check_sku(self, sku: str) -> Optional[DiscoveredProduct]:
        """Check if a SKU exists on Walmart.ca."""
        url = WALMART_PRODUCT_URL.format(sku=sku)
        body = await fetch_client.get(url, max_retries=1, timeout=10)
        if not body:
            return None

        # Check for valid product page (not 404/redirect)
        if "item does not exist" in body.lower():
            return None
        if "__NEXT_DATA__" not in body:
            return None

        # Try to extract basic info from __NEXT_DATA__
        title, price = self._parse_next_data(body)

        return DiscoveredProduct(
            sku=sku,
            source="sku_range",
            retailer="walmart_ca",
            url=url,
            title=title,
            current_price=price,
            evidence={"method": "sku_range", "url": url},
        )

    def _parse_next_data(self, html: str) -> tuple[Optional[str], Optional[float]]:
        """Extract title and price from Walmart __NEXT_DATA__."""
        import re
        match = re.search(
            r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
            html,
            re.DOTALL,
        )
        if not match:
            return None, None

        try:
            data = json.loads(match.group(1))
            product = data["props"]["pageProps"]["initialData"]["data"]["product"]
            title = product.get("name")
            price_data = product.get("priceInfo", {}).get("currentPrice", {})
            price = price_data.get("price")
            return title, price
        except (json.JSONDecodeError, KeyError, TypeError):
            return None, None
