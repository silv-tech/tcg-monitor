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
from src.modules.sitemap.differ import fetch_sitemap_index, fetch_sitemap, diff_sitemap

logger = logging.getLogger(__name__)

SITEMAP_INDEX = "https://www.walmart.ca/sitemap-product-1p-en.xml"

# Walmart.ca product URL patterns:
#   /en/ip/product-name/6000XXXXXXX  (newer)
#   /ip/product-name/6000XXXXXXX     (also valid)
SKU_PATTERN = re.compile(r"/ip/[^/]+/(\d{10,13})(?:\?|$|#)")


def extract_sku(url: str) -> Optional[str]:
    m = SKU_PATTERN.search(url)
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


def url_matches_tokens(url: str, tokens: list[str]) -> bool:
    """Check if the URL slug contains any of the configured tokens."""
    url_lower = url.lower()
    return any(token in url_lower for token in tokens)


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

        # Step 2: Fetch all child sitemaps to collect product URLs
        all_product_urls = []
        for child_url in child_urls:
            product_urls = await fetch_sitemap(child_url)
            all_product_urls.extend(product_urls)
            logger.debug(f"  {child_url}: {len(product_urls)} URLs")

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
