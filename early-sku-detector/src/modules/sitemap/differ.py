"""
Sitemap differ — downloads sitemap index + child sitemaps (.xml.gz),
diffs against DB to find new product URLs.
"""
import gzip
import logging
from datetime import datetime, timezone
from typing import Optional
from xml.etree import ElementTree as ET

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models import SitemapUrl
from src.fetch.client import fetch_client

logger = logging.getLogger(__name__)

NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}


async def fetch_sitemap_index(index_url: str) -> list[str]:
    """Fetch a sitemap index (plain XML) and return child sitemap URLs."""
    body = await fetch_client.get(index_url, accept_xml=True)
    if not body:
        logger.error(f"Failed to fetch sitemap index: {index_url}")
        return []

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

    logger.info(f"Sitemap index has {len(urls)} child sitemaps")
    return urls


async def fetch_sitemap_gz(sitemap_url: str) -> list[str]:
    """Fetch a gzipped sitemap (.xml.gz) and return product URLs."""
    raw_bytes = await fetch_client.get_bytes(sitemap_url)
    if not raw_bytes:
        logger.warning(f"Failed to fetch sitemap: {sitemap_url}")
        return []

    # Decompress gzip
    try:
        xml_bytes = gzip.decompress(raw_bytes)
        xml_text = xml_bytes.decode("utf-8")
    except Exception as e:
        logger.error(f"Gzip decompress failed for {sitemap_url}: {e}")
        # Maybe it's already plain XML (not gzipped)
        try:
            xml_text = raw_bytes.decode("utf-8")
        except Exception:
            return []

    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        logger.error(f"XML parse error on {sitemap_url}: {e}")
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
    Updates last_seen_at for existing URLs.
    """
    if not sitemap_urls:
        return []

    now = datetime.now(timezone.utc)

    # First, get all existing URLs for this retailer
    result = await session.execute(
        select(SitemapUrl.url).where(SitemapUrl.retailer == retailer)
    )
    existing_urls = {row[0] for row in result.all()}

    # Find truly new URLs
    new_urls = [u for u in sitemap_urls if u not in existing_urls]

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

    logger.info(
        f"Sitemap diff for {retailer}: {len(sitemap_urls)} total, {len(new_urls)} new"
    )
    return new_urls
