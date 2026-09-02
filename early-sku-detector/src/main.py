"""
Main entry point — APScheduler orchestrator.
Currently Walmart-only sitemap scanning.
"""
import asyncio
import logging
import sys

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from src.config import settings
from src.db.session import AsyncSessionLocal, engine
from src.db.models import Base
from src.modules.sitemap.retailers.walmart import WalmartSitemapModule
from src.pipeline.processor import process_discoveries

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger("early_sku_detector")


async def init_db():
    """Create all tables if they don't exist."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified")


async def run_sitemap_scan():
    """Run sitemap diff for Walmart Canada."""
    logger.info("=== Walmart sitemap scan starting ===")
    try:
        async with AsyncSessionLocal() as session:
            module = WalmartSitemapModule()
            products = await module.run(session)
            if products:
                stats = await process_discoveries(products, session)
                logger.info(f"Sitemap scan results: {stats}")
            else:
                logger.info("Sitemap scan: no new products found")
    except Exception as e:
        logger.error(f"Sitemap scan failed: {e}", exc_info=True)


async def main():
    logger.info("Early SKU Detector starting up — Walmart CA only")
    logger.info(f"Sitemap interval: {settings.sitemap_interval_hours}h")
    logger.info(f"Rate limit: {settings.request_rate_limit} req/s per domain")

    # Initialize database
    await init_db()

    # Run initial scan immediately
    await run_sitemap_scan()

    # Set up scheduler for recurring scans
    scheduler = AsyncIOScheduler()

    scheduler.add_job(
        run_sitemap_scan,
        trigger=IntervalTrigger(hours=settings.sitemap_interval_hours),
        id="sitemap_scan",
        name="Walmart Sitemap Diff",
        max_instances=1,
    )

    scheduler.start()
    logger.info(f"Scheduler started — next scan in {settings.sitemap_interval_hours}h")

    # Keep running forever
    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        scheduler.shutdown()
        await engine.dispose()
        logger.info("Early SKU Detector shut down")


if __name__ == "__main__":
    asyncio.run(main())
