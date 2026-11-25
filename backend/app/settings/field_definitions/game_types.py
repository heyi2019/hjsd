"""游戏类型标准主数据服务。"""
from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.shared.numbering import allocate_number, ensure_sequence
from app.shared.game_references import archive_game_references
from app.core.errors import ErrorCode, NotFound, Validation
from app.domain.enums import AuditAction
from app.domain.foundation import GameTypeOption
from ._common import _non_negative_int, _required_bool, _required_name, _snapshot


def list_game_types(session: Session, *, include_inactive: bool = True) -> list[GameTypeOption]:
    stmt = select(GameTypeOption).order_by(GameTypeOption.sort_order, GameTypeOption.id)
    if not include_inactive:
        stmt = stmt.where(GameTypeOption.is_active.is_(True))
    return list(session.scalars(stmt))


def _lock_game_types(session: Session) -> None:
    """默认、启停、删除和名称判重在同一事务内串行化。"""
    session.execute(select(func.pg_advisory_xact_lock(1212831574, 1)))


def _get_game_type_or_404(session: Session, game_type_id: int, *, refresh: bool = False) -> GameTypeOption:
    item = session.scalar(select(GameTypeOption).where(GameTypeOption.id == game_type_id).execution_options(populate_existing=True)) if refresh else session.get(GameTypeOption, game_type_id)
    if item is None:
        raise NotFound("游戏类型不存在", details={"game_type_id": game_type_id})
    return item


def _channel_regions(session: Session, regions: list[dict[str, str]], existing: list | None = None) -> list[dict[str, str]]:
    previous = {item["value"]: item for item in (existing or []) if isinstance(item, dict) and "value" in item}
    result: list[dict[str, str]] = []
    labels: set[str] = set()
    values: set[str] = set()
    for region in regions:
        label = _required_name(region.get("label"), field="channel_regions.label")
        if label in labels:
            raise Validation("渠道／区服名称不能重复")
        labels.add(label)
        value = region.get("value")
        if value:
            if value not in previous or value in values:
                raise Validation("渠道／区服编码无效或重复", details={"value": value})
        else:
            ensure_sequence(session, "GAME_CHANNEL", "channel_", 2)
            value = allocate_number(session, "GAME_CHANNEL")
        values.add(value)
        result.append({"value": value, "label": label})
    return result


def create_game_type(
    session: Session, *, name: str, actor: str, sort_order: int = 0, is_default: bool = False, channel_regions: list[dict[str, str]] | None = None
) -> GameTypeOption:
    normalized_name = _required_name(name, field="name")
    sort_order = _non_negative_int(sort_order, field="sort_order")
    _lock_game_types(session)
    regions = _channel_regions(session, channel_regions or [])
    if session.scalar(select(GameTypeOption).where(GameTypeOption.name == normalized_name)) is not None:
        raise Validation(
            f"游戏类型已存在：{normalized_name}",
            code=ErrorCode.DUPLICATE_CODE,
            details={"name": normalized_name},
        )
    item = GameTypeOption(
        name=normalized_name,
        sort_order=sort_order,
        is_active=True,
        is_default=bool(is_default),
        channel_regions=regions,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    if is_default:
        session.execute(update(GameTypeOption).where(GameTypeOption.id != item.id).values(is_default=False))
    record_audit(
        session,
        action=AuditAction.GAME_TYPE_CREATE,
        entity_type="GameTypeOption",
        entity_id=item.id,
        actor=actor,
        after=_snapshot(item, ("name", "sort_order", "is_active", "is_default", "channel_regions")),
    )
    return item


def update_game_type(
    session: Session,
    game_type_id: int,
    *,
    actor: str,
    name: str | None = None,
    sort_order: int | None = None,
    channel_regions: list[dict[str, str]] | None = None,
) -> GameTypeOption:
    _lock_game_types(session)
    item = _get_game_type_or_404(session, game_type_id, refresh=True)
    normalized_name = _required_name(name, field="name") if name is not None else None
    if normalized_name is not None:
        duplicate = session.scalar(select(GameTypeOption).where(GameTypeOption.name == normalized_name, GameTypeOption.id != item.id))
        if duplicate is not None:
            raise Validation(f"游戏类型已存在：{normalized_name}", code=ErrorCode.DUPLICATE_CODE)
    if sort_order is not None:
        sort_order = _non_negative_int(sort_order, field="sort_order")
    regions = None if channel_regions is None else _channel_regions(session, channel_regions, item.channel_regions)
    if regions is not None:
        active_values = {region["value"] for region in regions}
        archive_game_references(session, [region for region in item.channel_regions or [] if region["value"] not in active_values], actor=actor)
    before = _snapshot(item, ("name", "sort_order", "channel_regions"))
    if normalized_name is not None:
        item.name = normalized_name
    if sort_order is not None:
        item.sort_order = sort_order
    if regions is not None:
        item.channel_regions = regions
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.GAME_TYPE_UPDATE,
        entity_type="GameTypeOption",
        entity_id=item.id,
        actor=actor,
        before=before,
        after=_snapshot(item, ("name", "sort_order", "channel_regions")),
    )
    return item


def set_game_type_active(session: Session, game_type_id: int, is_active: bool, *, actor: str) -> GameTypeOption:
    is_active = _required_bool(is_active, field="is_active")
    _lock_game_types(session)
    item = _get_game_type_or_404(session, game_type_id, refresh=True)
    if not is_active and item.is_default:
        raise Validation("默认游戏类型不能停用", details={"game_type_id": item.id})
    before = _snapshot(item, ("is_active",))
    item.is_active = is_active
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.GAME_TYPE_DISABLE,
        entity_type="GameTypeOption",
        entity_id=item.id,
        actor=actor,
        before=before,
        after=_snapshot(item, ("is_active",)),
    )
    return item


def set_game_type_default(session: Session, game_type_id: int, is_default: bool, *, actor: str) -> GameTypeOption:
    is_default = _required_bool(is_default, field="is_default")
    _lock_game_types(session)
    item = _get_game_type_or_404(session, game_type_id, refresh=True)
    if is_default and not item.is_active:
        raise Validation("停用的游戏类型不能设为默认")
    before = _snapshot(item, ("is_default",))
    if is_default:
        session.execute(update(GameTypeOption).values(is_default=False))
    item.is_default = is_default
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.GAME_TYPE_DEFAULT,
        entity_type="GameTypeOption",
        entity_id=item.id,
        actor=actor,
        before=before,
        after=_snapshot(item, ("is_default",)),
    )
    return item


def delete_game_type(session: Session, game_type_id: int, *, actor: str) -> None:
    _lock_game_types(session)
    item = _get_game_type_or_404(session, game_type_id, refresh=True)
    if item.is_default:
        raise Validation("默认游戏类型不能删除")
    archive_game_references(session, [{"value": item.value, "label": item.name}, *(item.channel_regions or [])], actor=actor)
    record_audit(
        session,
        action=AuditAction.GAME_TYPE_DELETE,
        entity_type="GameTypeOption",
        entity_id=item.id,
        actor=actor,
        before=_snapshot(item, ("name", "sort_order", "is_active", "is_default", "channel_regions")),
    )
    session.delete(item)
