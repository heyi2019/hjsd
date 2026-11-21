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
    system_unlisted: set[str] = set()
    unlisted_platforms: dict[str, set[str]] = {}
    for event in events:
        extra = event.form_extra or {}
        if extra.get("operation_type") != "UNLIST":
            continue
        event_id = str(extra.get("consignment_event_id"))
        if extra.get("platform_unlist_scope") == "SYSTEM":
            system_unlisted.add(event_id)
        else:
            platforms = extra.get("consignment_platforms")
            if isinstance(platforms, list):
                unlisted_platforms.setdefault(event_id, set()).update(
                    value for value in platforms if isinstance(value, str)
                )
    active = set()
    for listing_id, platform in listings:
        key = str(listing_id)
        if key not in system_unlisted and platform not in unlisted_platforms.get(key, ()):
            active.add((listing_id, platform))
    return active
