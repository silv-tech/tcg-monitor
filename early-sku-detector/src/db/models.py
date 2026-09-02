from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    String, Text, Integer, Boolean, DateTime, Numeric,
    Index, ForeignKey, JSON, UniqueConstraint, Date,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    upc: Mapped[Optional[str]] = mapped_column(String(14))
    title: Mapped[Optional[str]] = mapped_column(Text)
    brand: Mapped[Optional[str]] = mapped_column(String(100))
    set_name: Mapped[Optional[str]] = mapped_column(String(200))
    product_type: Mapped[Optional[str]] = mapped_column(String(50))
    msrp: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 2))
    current_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(10, 2))
    seller_type: Mapped[Optional[str]] = mapped_column(String(10))  # '1p' or 'marketplace'
    state: Mapped[str] = mapped_column(String(20), nullable=False, default="DISCOVERED")
    confidence: Mapped[Decimal] = mapped_column(Numeric(3, 2), nullable=False, default=Decimal("0.0"))
    source_flags: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    first_priced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    first_buyable_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    first_search_visible_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (
        Index("idx_products_state", "state"),
        Index("idx_products_upc", "upc"),
    )


# Source flag constants
SOURCE_SITEMAP = 1
SOURCE_UPC = 2
SOURCE_SKU_RANGE = 4


# Valid state transitions (can skip forward, never backward)
STATES_ORDERED = ["DISCOVERED", "LISTED", "PRICED", "PREORDER", "IN_STOCK", "OOS"]
VALID_TRANSITIONS = {}
for i, s in enumerate(STATES_ORDERED):
    VALID_TRANSITIONS[s] = set(STATES_ORDERED[i + 1:])


class SkuEvent(Base):
    __tablename__ = "sku_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(50), ForeignKey("products.sku"), nullable=False)
    from_state: Mapped[Optional[str]] = mapped_column(String(20))
    to_state: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    evidence: Mapped[Optional[dict]] = mapped_column(JSON)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        Index("idx_sku_events_sku", "sku"),
        Index("idx_sku_events_observed", "observed_at"),
    )


class SitemapUrl(Base):
    __tablename__ = "sitemap_urls"

    id: Mapped[int] = mapped_column(primary_key=True)
    retailer: Mapped[str] = mapped_column(String(20), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    sku: Mapped[Optional[str]] = mapped_column(String(50))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("retailer", "url", name="uq_sitemap_retailer_url"),
        Index("idx_sitemap_urls_retailer", "retailer"),
        Index("idx_sitemap_urls_first_seen", "first_seen_at"),
    )


class ScannedId(Base):
    __tablename__ = "scanned_ids"

    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    hit: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    anchor_sku: Mapped[Optional[str]] = mapped_column(String(50))
    scanned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class ReleaseDate(Base):
    __tablename__ = "release_dates"

    id: Mapped[int] = mapped_column(primary_key=True)
    set_code: Mapped[Optional[str]] = mapped_column(String(20))
    set_name: Mapped[str] = mapped_column(String(200), nullable=False)
    release_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    source: Mapped[Optional[str]] = mapped_column(String(100))


class FilterRejection(Base):
    __tablename__ = "filter_rejections"

    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[Optional[str]] = mapped_column(String(50))
    title: Mapped[Optional[str]] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON)
    rejected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
