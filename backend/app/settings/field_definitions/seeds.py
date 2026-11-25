"""settings.field_definitions.seeds：M0 基础主数据种子（**幂等**，可重复执行）。

生产初始化的种子内容包括：
- 三类主业务 `HS` 回收 / `TH` 提号 / `DG` 代挂（PRD §2.0）；
- 业务零本金标记（DG 代挂为 `is_zero_principal`，不垫付本金）；
- 各编号域初始化（订单按业务独立、客户 CUS、合作方 CP 等）。

示例资金账户和游戏类型仅供隔离测试显式启用，不用于生产初始化。

幂等规则：按 `code` 判定，已存在则**跳过且不改写**（保护运行期的改名与停用）。
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.shared.numbering import ensure_sequence
from app.domain.enums import (
    AuditAction,
    SequenceKey,
)
from app.settings.field_definitions.order_types import create_order_type, get_order_type_by_code

SEED_ACTOR = "system"

# (code, name, is_zero_principal, sort_order, description)
SEED_ORDER_TYPES: tuple[tuple[str, str, bool, int, str], ...] = (
    ("HS", "回收", False, 10, "客户把号卖给我，我择机卖出（垫付本金）"),
    ("TH", "提号", False, 20, "买家找我买号，我去同行那里提号卖给他（垫付本金）"),
    ("DG", "代挂", True, 30, "客户让我帮忙卖他的号，我收服务费（零本金，不垫付）"),
)

# (sequence_key, prefix, padding) —— 订单编号域随业务动态生成，此处只初始化非订单域
SEED_SEQUENCES: tuple[tuple[str, str, int], ...] = (
    (SequenceKey.CUSTOMER.value, "CUS", 4),
    (SequenceKey.COUNTERPARTY.value, "CP", 4),
    (SequenceKey.LEAD.value, "REQ", 4),
    (SequenceKey.NOTIFICATION.value, "NTF", 4),
    # 资金流水按方向独立递增（2026-10-28 口径）：支出 ZC+五位、收入 SR+五位。
    (SequenceKey.CASHFLOW_OUT.value, "ZC", 5),
    (SequenceKey.CASHFLOW_IN.value, "SR", 5),
    # 库存编号（KU_ 序列，2026-10-28 口径）：KU_ + 五位流水（KU_00001…），
    # 独立于业务订单，账号创建时自动发放。
    (SequenceKey.STOCK_NO.value, "KU_", 5),
)


def seed_foundation(session: Session, *, actor: str = SEED_ACTOR,
                    include_example_data: bool = False) -> dict[str, int]:
    """写入 M0 种子；返回各对象的“新建数 / 跳过数”，便于迁移与测试断言。"""
    stats: dict[str, int] = {
        "pools_created": 0,
        "pools_skipped": 0,
        "order_types_created": 0,
        "order_types_skipped": 0,
        "default_pool_marked": 0,
        "sequences_created": 0,
        "game_types_created": 0,
        "game_types_skipped": 0,
    }

    if include_example_data:
        from scripts.test_example_seed import seed_example_data
        seed_example_data(session, actor=actor, stats=stats)

    for code, name, is_zero_principal, sort_order, description in SEED_ORDER_TYPES:
        existing = get_order_type_by_code(session, code)
        if existing is not None:
            stats["order_types_skipped"] += 1
            order_type = existing
        else:
            order_type = create_order_type(
                session,
                code=code,
                name=name,
                is_zero_principal=is_zero_principal,
                actor=actor,
                sort_order=sort_order,
                description=description,
            )
            stats["order_types_created"] += 1
        ensure_sequence(session, order_type.sequence_key, order_type.sequence_prefix, 4)

    for sequence_key, prefix, padding in SEED_SEQUENCES:
        _ensure_sequence_once(session, sequence_key, prefix, stats, padding=padding)

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


def _ensure_sequence_once(
    session: Session, sequence_key: str, prefix: str, stats: dict[str, int], *, padding: int = 4
) -> None:
    from app.domain.foundation import DocumentSequence

    exists = (
        session.query(DocumentSequence)
        .filter(DocumentSequence.sequence_key == sequence_key)
        .first()
    )
    if exists is None:
        ensure_sequence(session, sequence_key, prefix, padding)
        stats["sequences_created"] += 1


def seed_is_applied(session: Session) -> bool:
    """判断 M0 种子是否已落地（迁移前置检查）。"""
    return (
        all(get_order_type_by_code(session, code) is not None for code in ("HS", "TH", "DG"))
    )


__all__ = ["SEED_ACTOR", "SEED_ORDER_TYPES", "seed_foundation", "seed_is_applied"]
