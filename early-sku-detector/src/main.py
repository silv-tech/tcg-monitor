"""
Main entry point — APScheduler orchestrator that runs all modules on schedule.
"""
import asyncio
import logging
import signal
import sys

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.db.session import AsyncSessionLocal, engine
from src.db.models import Base
from src.modules.sitemap.retailers.walmart import WalmartSitemapModule
from src.modules.upc.scanner import UPCScannerModule
from src.modules.sku_range.scanner import SKURangeScannerModule
from src.pipeline.processor import process_discoveries

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("early_sku_detector")


async def init_db():
    """Create all tables if they don't exist."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables verified")


async def run_sitemap_scan():
    """Run sitemap diff for all configured retailers."""
    logger.info("=== Sitemap scan starting ===")
    async with AsyncSessionLocal() as session:
        module = WalmartSitemapModule()
        products = await module.run(session)
        if products:
            stats = await process_discoveries(products, session)
            logger.info(f"Sitemap scan results: {stats}")
        else:
            logger.info("Sitemap scan: no new products")


async def run_upc_scan():
    """Run UPC database scanner."""
    logger.info("=== UPC scan starting ===")
    async with AsyncSessionLocal() as session:
        module = UPCScannerModule()
        products = await module.run(session)
        if products:
            stats = await process_discoveries(products, session)
            logger.info(f"UPC scan results: {stats}")
        else:
            logger.info("UPC scan: no hits")


async def run_sku_range_scan():
    """Run SKU range scanner."""
    logger.info("=== SKU range scan starting ===")
    async with AsyncSessionLocal() as session:
        module = SKURangeScannerModule()
        products = await module.run(session)
        if products:
            stats = await process_discoveries(products, session)
            logger.info(f"SKU range scan results: {stats}")
        else:
            logger.info("SKU range scan: no discoveries")


async def main():
    logger.info("Early SKU Detector starting up")

    # Initialize database
    await init_db()

    # Run initial scans immediately
    logger.info("Running initial sitemap scan...")
    await run_sitemap_scan()

    # Set up scheduler
    scheduler = AsyncIOScheduler()

    scheduler.add_job(
        run_sitemap_scan,
        trigger=IntervalTrigger(hours=settings.sitemap_interval_hours),
        id="sitemap_scan",
        name="Sitemap Diff Scanner",
        max_instances=1,
    )

    scheduler.add_job(
        run_upc_scan,
        trigger=IntervalTrigger(hours=settings.upc_scan_interval_hours),
        id="upc_scan",
        name="UPC Database Scanner",
        max_instances=1,
    )

    scheduler.add_job(
        run_sku_range_scan,
        trigger=IntervalTrigger(hours=settings.sku_range_interval_hours),
        id="sku_range_scan",
        name="SKU Range Scanner",
        max_instances=1,
    )

    scheduler.start()
    logger.info(
        f"Scheduler started — sitemap every {settings.sitemap_interval_hours}h, "
        f"UPC every {settings.upc_scan_interval_hours}h, "
        f"SKU range every {settings.sku_range_interval_hours}h"
    )

    # Keep running
    stop_event = asyncio.Event()

    def _signal_handler():
        logger.info("Shutdown signal received")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    try:
        await stop_event.wait()
    except KeyboardInterrupt:
        pass
    finally:
        scheduler.shutdown()
        await engine.dispose()
        logger.info("Early SKU Detector shut down")


if __name__ == "__main__":
    asyncio.run(main())
