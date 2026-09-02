"""Load seed data into the database."""
import asyncio
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from src.db.session import AsyncSessionLocal, engine
from src.db.models import Base, Product

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def load_seeds():
    """Load known products from seed file."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    with open("seed/known_products.json") as f:
        data = json.load(f)

    async with AsyncSessionLocal() as session:
        loaded = 0
        for item in data["products"]:
            existing = await session.execute(
                select(Product).where(Product.sku == item["sku"])
            )
            if existing.scalar_one_or_none():
                logger.info(f"  Skip {item['sku']} (already exists)")
                continue

            product = Product(
                sku=item["sku"],
                title=item.get("title"),
                upc=item.get("upc"),
                brand=item.get("brand"),
                state="DISCOVERED",
                source_flags=0,
                first_seen_at=datetime.now(timezone.utc),
            )
            session.add(product)
            loaded += 1
            logger.info(f"  Added {item['sku']}: {item.get('title', 'N/A')}")

        await session.commit()
        logger.info(f"Loaded {loaded} seed products")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(load_seeds())
