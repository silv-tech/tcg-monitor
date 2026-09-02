from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy import create_engine
from src.config import settings

engine = create_async_engine(settings.database_url, echo=False, pool_size=5)
sync_engine = create_engine(settings.database_url_sync, echo=False)

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
