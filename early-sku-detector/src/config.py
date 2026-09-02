from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql+asyncpg://detector:detector_local@localhost:5433/early_sku"
    database_url_sync: str = "postgresql://detector:detector_local@localhost:5433/early_sku"

    # Proxies
    proxy_residential_url: Optional[str] = None
    proxy_residential_us_url: Optional[str] = None

    # Discord
    discord_webhook_url: Optional[str] = None

    # Request settings
    request_rate_limit: float = 2.0        # requests per second per domain
    request_timeout: int = 15              # seconds
    max_concurrent_requests: int = 5

    # Sitemap settings
    sitemap_interval_hours: int = 12       # how often to diff sitemaps
    sitemap_slug_tokens_file: str = "config/slug_tokens.yml"

    # UPC scanner settings
    upc_scan_interval_hours: int = 6
    upc_batch_size: int = 50

    # SKU range scanner settings
    sku_range_interval_hours: int = 4
    sku_range_window: int = 200            # ±N around anchor
    sku_range_hit_threshold: float = 0.02  # min hit density to keep expanding
    sku_range_max_window: int = 1000

    # Confidence scoring
    confidence_single_source: float = 0.3
    confidence_two_sources: float = 0.6
    confidence_three_sources: float = 0.9

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
