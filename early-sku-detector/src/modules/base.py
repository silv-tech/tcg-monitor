"""Base interface for retailer modules."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


@dataclass
class DiscoveredProduct:
    """A product discovered by any module."""
    sku: str
    source: str  # "sitemap", "upc", "sku_range"
    retailer: str
    url: Optional[str] = None
    title: Optional[str] = None
    brand: Optional[str] = None
    set_name: Optional[str] = None
    product_type: Optional[str] = None
    upc: Optional[str] = None
    msrp: Optional[float] = None
    current_price: Optional[float] = None
    seller_type: Optional[str] = None  # "1p" or "marketplace"
    in_stock: bool = False
    observed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    evidence: dict = field(default_factory=dict)


class RetailerModule(ABC):
    """Interface that every retailer scanner must implement."""

    retailer_name: str = ""

    @abstractmethod
    async def run(self, session) -> list[DiscoveredProduct]:
        """Execute the scan and return discovered products."""
        ...
