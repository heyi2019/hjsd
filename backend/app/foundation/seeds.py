"""foundation.seeds：M0 基础主数据种子（**幂等**，可重复执行）。

种子内容包括：
- 资金池 `HJ_INVEST`（投资款荷包）/ `HJ_PROFIT`（利润荷包）（PRD §1.2）；
- 四类主业务 `HS` 回收 / `TH` 提号 / `DG` 代挂 / `DFQ` 代分期（PRD §2.0）；
- 业务↔资金池默认路由（本金→投资款池，利润→利润池；DG 总额→利润池）；
- 各编号域初始化（订单按业务独立、客户 CUS、合作方 CP 等）。

幂等规则：按 `code` 判定，已存在则**跳过且不改写**（保护运行期的改名与停用）。
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.numbering import ensure_sequence
from app.domain.enums import (
    AuditAction,
    CapitalType,
    PoolOwnership,
    PoolType,
    Portion,
    SequenceKey,
)
from app.domain.foundation import OrderTypeDef
from app.foundation import service

SEED_ACTOR = "system"

# (code, name, pool_type, ownership)
SEED_POOLS: tuple[tuple[str, str, str, str], ...] = (
    ("HJ_INVEST", "投资款荷包", PoolType.INVEST.value, PoolOwnership.OWNED.value),
    ("HJ_PROFIT", "利润荷包", PoolType.PROFIT.value, PoolOwnership.OWNED.value),
)

# (code, name, capital_type, sort_order, description)
SEED_ORDER_TYPES: tuple[tuple[str, str, str, int, str], ...] = (
    ("HS", "回收", CapitalType.STOCK.value, 10, "客户把号卖给我，我择机卖出（库存型）"),
    ("TH", "提号", CapitalType.STOCK.value, 20, "买家找我买号，我去同行那里提号卖给他（库存型）"),
    ("DG", "代挂", CapitalType.ZERO.value, 30, "客户让我帮忙卖他的号，我收服务费（零本金型）"),
    ("DFQ", "代分期", CapitalType.CREDIT.value, 40, "代客户买号，到期账号再换绑给他（垫资型）"),
)

SEED_GAME_TYPES: tuple[tuple[str, int, bool], ...] = (
    ("王者荣耀", 10, True),
    ("原神", 20, False),
)

# (order_type_code, portion, pool_code)
SEED_ROUTES: tuple[tuple[str, str, str], ...] = (
    ("HS", Portion.PRINCIPAL.value, "HJ_INVEST"),
    ("HS", Portion.PROFIT.value, "HJ_PROFIT"),
    ("TH", Portion.PRINCIPAL.value, "HJ_INVEST"),
    ("TH", Portion.PROFIT.value, "HJ_PROFIT"),
    ("DG", Portion.PROFIT.value, "HJ_PROFIT"),
    ("DG", Portion.GROSS.value, "HJ_PROFIT"),
    ("DFQ", Portion.PRINCIPAL.value, "HJ_INVEST"),
    ("DFQ", Portion.PROFIT.value, "HJ_PROFIT"),
)

# (sequence_key, prefix) —— 订单编号域随业务动态生成，此处只初始化非订单域
SEED_SEQUENCES: tuple[tuple[str, str], ...] = (
    (SequenceKey.CUSTOMER.value, "CUS"),
    (SequenceKey.COUNTERPARTY.value, "CP"),
    (SequenceKey.LEAD.value, "REQ"),
    (SequenceKey.QUALITY_ISSUE.value, "QI"),
    (SequenceKey.NOTIFICATION.value, "NTF"),
    (SequenceKey.CASHFLOW.value, "CF"),
    (SequenceKey.IMPORT.value, "IMP"),
    (SequenceKey.ATTACHMENT.value, "ATT"),
)


def seed_foundation(session: Session, *, actor: str = SEED_ACTOR) -> dict[str, int]:
    """写入 M0 种子；返回各对象的“新建数 / 跳过数”，便于迁移与测试断言。"""
    stats: dict[str, int] = {
        "pools_created": 0,
        "pools_skipped": 0,
        "order_types_created": 0,
        "order_types_skipped": 0,
        "routes_created": 0,
        "routes_updated": 0,
        "sequences_created": 0,
        "game_types_created": 0,
        "game_types_skipped": 0,
    }

    for code, name, pool_type, ownership in SEED_POOLS:
        if service.get_pool_by_code(session, code) is not None:
            stats["pools_skipped"] += 1
            continue
        service.create_pool(
            session,
            code=code,
            name=name,
            actor=actor,
            pool_type=pool_type,
            ownership=ownership,
            note="M0 系统种子",
        )
        stats["pools_created"] += 1

    for code, name, capital_type, sort_order, description in SEED_ORDER_TYPES:
        existing = service.get_order_type_by_code(session, code)
        if existing is not None:
            stats["order_types_skipped"] += 1
            order_type = existing
        else:
            order_type = service.create_order_type(
                session,
                code=code,
                name=name,
                capital_type=capital_type,
                actor=actor,
                sort_order=sort_order,
                description=description,
            )
            stats["order_types_created"] += 1
        ensure_sequence(session, order_type.sequence_key, order_type.sequence_prefix, 4)

    for name, sort_order, is_default in SEED_GAME_TYPES:
        existing = next((item for item in service.list_game_types(session) if item.name == name), None)
        if existing is not None:
            stats["game_types_skipped"] += 1
            continue
        service.create_game_type(
            session,
            name=name,
            sort_order=sort_order,
            is_default=is_default,
            actor=actor,
        )
        stats["game_types_created"] += 1

    for order_type_code, portion, pool_code in SEED_ROUTES:
        order_type = service.get_order_type_by_code(session, order_type_code)
        if order_type is None:
            continue
        existed = _route_exists(session, order_type.id, portion)
        service.set_route(
            session,
            order_type_code=order_type_code,
            portion=portion,
            pool_code=pool_code,
            actor=actor,
        )
        stats["routes_updated" if existed else "routes_created"] += 1

    # 路由就绪后启用业务：一次执行即达到可用状态，不依赖“再跑一遍种子”
    for code, _name, _capital_type, _sort_order, _description in SEED_ORDER_TYPES:
        order_type = service.get_order_type_by_code(session, code)
        if order_type is None or order_type.is_active:
            continue
        if _route_exists_any(session, order_type.id):
            service.set_order_type_active(session, order_type.id, True, actor=actor)

    for sequence_key, prefix in SEED_SEQUENCES:
        _ensure_sequence_once(session, sequence_key, prefix, stats)

    record_audit(
        session,
        action=AuditAction.POOL_CREATE,
        entity_type="Seed",
        entity_id="M0",
        actor=actor,
        after=dict(stats),
        reason="M0 基础种子执行（幂等）",
    )
    session.flush()
    return stats


def _route_exists_any(session: Session, order_type_id: int) -> bool:
    return bool(service.list_routes(session, order_type_id=order_type_id))


def _route_exists(session: Session, order_type_id: int, portion: str) -> bool:
    return any(
        route.order_type_id == order_type_id and route.portion == portion
        for route in service.list_routes(session, order_type_id=order_type_id)
    )


def _ensure_sequence_once(
    session: Session, sequence_key: str, prefix: str, stats: dict[str, int]
) -> None:
    from app.domain.foundation import DocumentSequence

    exists = (
        session.query(DocumentSequence)
        .filter(DocumentSequence.sequence_key == sequence_key)
        .first()
    )
    if exists is None:
        ensure_sequence(session, sequence_key, prefix, 4)
        stats["sequences_created"] += 1


def seed_is_applied(session: Session) -> bool:
    """判断 M0 种子是否已落地（迁移前置检查）。"""
    return (
        service.get_pool_by_code(session, "HJ_INVEST") is not None
        and service.get_pool_by_code(session, "HJ_PROFIT") is not None
        and all(service.get_order_type_by_code(session, code) is not None for code in ("HS", "TH", "DG", "DFQ"))
        and _all_seed_routes_ready(session)
        and all(
            any(item.name == name for item in service.list_game_types(session))
            for name, _sort_order, _is_default in SEED_GAME_TYPES
        )
    )


def _all_seed_routes_ready(session: Session) -> bool:
    for order_type_code, portion, _pool_code in SEED_ROUTES:
        order_type: OrderTypeDef | None = service.get_order_type_by_code(session, order_type_code)
        if order_type is None or not _route_exists(session, order_type.id, portion):
            return False
    return True


__all__ = ["SEED_ACTOR", "SEED_POOLS", "SEED_ORDER_TYPES", "SEED_ROUTES", "SEED_GAME_TYPES", "seed_foundation", "seed_is_applied"]
