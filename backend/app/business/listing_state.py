"""按上架事件和平台计算当前有效寄售记录。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.domain.trade import OrderEvent


def validate_unique_platforms(platforms: object) -> None:
    if isinstance(platforms, list):
        names = [value.strip() for value in platforms if isinstance(value, str) and value.strip()]
        if len(names) != len(set(names)):
            raise Validation("同一上架记录不能重复选择平台")


def active_listings(db: Session, order_id: int) -> set[tuple[int, str]]:
    events = list(db.scalars(select(OrderEvent).where(
        OrderEvent.order_id == order_id, OrderEvent.event_type == "OPERATE", OrderEvent.is_posted.is_(True)
    )).all())
    listings: set[tuple[int, str]] = set()
    for event in events:
        extra = event.form_extra or {}
        if extra.get("operation_type") != "CONSIGNMENT":
            continue
        platforms = extra.get("consignment_platforms")
        if isinstance(platforms, list):
            listings.update((event.id, value.strip()) for value in platforms if isinstance(value, str) and value.strip())
    for event in events:
        extra = event.form_extra or {}
        if extra.get("operation_type") != "UNLIST":
            continue
        event_id = extra.get("consignment_event_id")
        if extra.get("platform_unlist_scope") == "SYSTEM":
            listings = {(listing_id, platform) for listing_id, platform in listings if str(listing_id) != str(event_id)}
        else:
            platforms = extra.get("consignment_platforms")
            if isinstance(platforms, list):
                listings = {(listing_id, platform) for listing_id, platform in listings if not (str(listing_id) == str(event_id) and platform in platforms)}
    return listings
