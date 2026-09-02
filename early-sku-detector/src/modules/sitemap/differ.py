"""
Sitemap differ — downloads sitemap index + child sitemaps,
diffs against DB to find new product URLs.
"""
import gzip
import logging
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Optional
from xml.etree import ElementTree as ET

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models import SitemapUrl
from src.fetch.client import fetch_client
from src.modules.base import DiscoveredProduct

logger = logging.getLogger(__name__)

NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


async def fetch_sitemap_index(index_url: str) -> list[str]:
    """Fetch a sitemap index and return child sitemap URLs."""
    body = await fetch_client.get(index_url, accept_xml=True)
    if not body:
        logger.error(f"Failed to fetch sitemap index: {index_url}")
        return []

    # Handle gzipped content
    try:
        body_bytes = body.encode("latin-1")
        if body_bytes[:2] == b"\x1f\x8b":
            body = gzip.decompress(body_bytes).decode("utf-8")
    except Exception:
        pass

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        logger.error(f"XML parse error on sitemap index: {e}")
        return []

    urls = []
    for sitemap in root.findall("sm:sitemap", NS):
        loc = sitemap.find("sm:loc", NS)
        if loc is not None and loc.text:
            urls.append(loc.text.strip())
    return urls


async def fetch_sitemap(sitemap_url: str) -> list[str]:
    """Fetch a single sitemap (possibly gzipped) and return product URLs."""
    body = await fetch_client.get(sitemap_url, accept_xml=True)
    if not body:
        logger.warning(f"Failed to fetch sitemap: {sitemap_url}")
        return []

    # Handle gzipped content
    try:
        body_bytes = body.encode("latin-1")
        if body_bytes[:2] == b"\x1f\x8b":
            body = gzip.decompress(body_bytes).decode("utf-8")
    except Exception:
        pass

    try:
        root = ET.fromstring(body)
    except ET.ParseError as e:
        logger.error(f"XML parse error on sitemap {sitemap_url}: {e}")
        return []

    urls = []
    for url_elem in root.findall("sm:url", NS):
        loc = url_elem.find("sm:loc", NS)
        if loc is not None and loc.text:
            urls.append(loc.text.strip())
    return urls


async def diff_sitemap(
    retailer: str,
    sitemap_urls: list[str],
    session: AsyncSession,
) -> list[str]:
    """
    Compare fetched sitemap URLs against DB.
    Returns list of NEW URLs not previously seen.
    Also updates last_seen_at for existing URLs.
    """
    if not sitemap_urls:
        return []

    now = datetime.now(timezone.utc)

    # Upsert all URLs — ON CONFLICT updates last_seen_at
    for batch_start in range(0, len(sitemap_urls), 500):
        batch = sitemap_urls[batch_start : batch_start + 500]
        stmt = pg_insert(SitemapUrl).values(
            [
                {
                    "retailer": retailer,
                    "url": url,
                    "first_seen_at": now,
                    "last_seen_at": now,
                }
                for url in batch
            ]
        )
        stmt = stmt.on_conflict_do_update(
            constraint="uq_sitemap_retailer_url",
            set_={"last_seen_at": now},
        )
        await session.execute(stmt)

    await session.flush()

    # Find URLs that were just inserted (first_seen_at == now)
    result = await session.execute(
        select(SitemapUrl.url).where(
            SitemapUrl.retailer == retailer,
            SitemapUrl.first_seen_at == now,
        )
    )
    new_urls = [row[0] for row in result.all()]

    logger.info(
        f"Sitemap diff for {retailer}: {len(sitemap_urls)} total, {len(new_urls)} new"
    )
    return new_urls
