"""
Walmart Canada sitemap scanner.

Walmart publishes sitemaps at:
  https://www.walmart.ca/sitemap-product-1p-en.xml  (index → child .xml.gz files)

Products appear in sitemaps days before they're searchable.
We diff against our DB to find new URLs, then extract SKU from the URL pattern.
"""
import logging
import re
from typing import Optional

import yaml

from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.fetch.client import fetch_client
from src.modules.base import DiscoveredProduct, RetailerModule
from src.modules.sitemap.differ import fetch_sitemap_index, fetch_sitemap_gz, diff_sitemap

logger = logging.getLogger(__name__)

SITEMAP_INDEX = "https://www.walmart.ca/sitemap-product-1p-en.xml"

# Walmart.ca product URL patterns:
#   /en/ip/Product-Name/6000XXXXXXXXX   (numeric — traditional)
#   /en/ip/Product-Name/5VO3JSEOMCPS    (alphanumeric — newer format)
SKU_PATTERN = re.compile(r"/ip/[^/]+/([A-Za-z0-9]{10,15})$")


def extract_sku(url: str) -> Optional[str]:
    # Strip query string / fragment before matching
    clean = url.split("?")[0].split("#")[0]
    m = SKU_PATTERN.search(clean)
    return m.group(1) if m else None


def load_slug_tokens() -> list[str]:
    """Load configurable slug tokens used to filter relevant products."""
    try:
        with open(settings.sitemap_slug_tokens_file, "r") as f:
            data = yaml.safe_load(f) or {}
        return [t.lower() for t in data.get("walmart", [])]
    except FileNotFoundError:
        logger.warning(f"Slug tokens file not found: {settings.sitemap_slug_tokens_file}")
        return ["pokemon", "tcg", "pikachu", "charizard", "booster", "trainer-box",
                "elite-trainer", "paldea", "scarlet", "violet", "obsidian"]


def _extract_slug(url: str) -> str:
    """Extract just the product-name slug from a Walmart URL, excluding the SKU ID."""
    # URL: https://www.walmart.ca/en/ip/Product-Name-Here/6000XXXXXXXXX
    # We want just "Product-Name-Here" (lowercased)
    parts = url.split("/ip/")
    if len(parts) < 2:
        return ""
    slug_and_sku = parts[1]
    # Remove the SKU ID (last path segment)
    segments = slug_and_sku.strip("/").split("/")
    if len(segments) >= 2:
        return segments[0].lower()
    return slug_and_sku.lower()


def url_matches_tokens(url: str, tokens: list[str]) -> bool:
    """Check if the URL product slug contains any of the configured tokens."""
    slug = _extract_slug(url)
    if not slug:
        return False
    return any(token in slug for token in tokens)


class WalmartSitemapModule(RetailerModule):
    retailer_name = "walmart_ca"

    async def run(self, session: AsyncSession) -> list[DiscoveredProduct]:
        """
        1. Fetch sitemap index
        2. Fetch each child sitemap
        3. Diff against DB to find new URLs
        4. Filter by slug tokens (only TCG-related)
        5. Return discovered products
        """
        tokens = load_slug_tokens()
        logger.info(f"Walmart sitemap scan starting with {len(tokens)} slug tokens")

        # Step 1: Get child sitemap URLs from index
        child_urls = await fetch_sitemap_index(SITEMAP_INDEX)
        if not child_urls:
            logger.error("No child sitemaps found in Walmart index")
            return []

        logger.info(f"Found {len(child_urls)} child sitemaps in index")

        # Step 2: Fetch all child sitemaps (.xml.gz) to collect product URLs
        all_product_urls = []
        for child_url in child_urls:
            product_urls = await fetch_sitemap_gz(child_url)
            all_product_urls.extend(product_urls)
            logger.info(f"  {child_url}: {len(product_urls)} URLs")

        logger.info(f"Total product URLs across all sitemaps: {len(all_product_urls)}")

        # Step 3: Diff against DB
        new_urls = await diff_sitemap(self.retailer_name, all_product_urls, session)
        if not new_urls:
            logger.info("No new URLs found in Walmart sitemaps")
            return []

        # Step 4: Filter by slug tokens
        matching_urls = [u for u in new_urls if url_matches_tokens(u, tokens)]
        logger.info(
            f"Filtered {len(new_urls)} new URLs → {len(matching_urls)} match slug tokens"
        )

        # Step 5: Build discovered products
        products = []
        for url in matching_urls:
            sku = extract_sku(url)
            if not sku:
                logger.debug(f"Could not extract SKU from {url}")
                continue

            products.append(
                DiscoveredProduct(
                    sku=sku,
                    source="sitemap",
                    retailer=self.retailer_name,
                    url=url,
                    evidence={"sitemap_url": url},
                )
            )

        logger.info(f"Walmart sitemap scan complete: {len(products)} new products")
        return products
