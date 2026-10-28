"""core.numbering：编号分配器（BAS-02-04）。

规则（PRD §2.1.1 / V19）：
- 纯顺序号、不含日期；主业务按类型独立递增（HS/TH/DG/DFQ 可并存同号）；
- 事务内递增，取消不回收，编号永不修改、永不复用；
- 4 位上限 9999，超出即抛 `SEQUENCE_EXHAUSTED`，**禁止静默进位**。
"""
from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.errors import ErrorCode, Validation
from app.domain.enums import Direction, SequenceKey
from app.domain.foundation import DocumentSequence

MAX_SEQUENCE_VALUE = 9999  # 默认 4 位序列上限；实际按各序列 padding 计算（10^padding - 1）
DEFAULT_PADDING = 4


def ensure_sequence(
    session: Session,
    key: str | SequenceKey,
    prefix: str,
    padding: int = DEFAULT_PADDING,
) -> DocumentSequence:
    """取（必要时建）编号序列；同一 key 幂等返回既有行。"""
    key_value = key.value if isinstance(key, SequenceKey) else key
    row = session.scalar(
        select(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    )
    if row is None:
        row = DocumentSequence(
            sequence_key=key_value,
            prefix=prefix,
            padding=padding,
            current_value=0,
        )
        session.add(row)
        session.flush()
    return row


def allocate_number(session: Session, key: str | SequenceKey) -> str:
    """在当前事务内分配下一个业务编号并返回，例如 `HS0001`。

    调用方必须处于事务中：编号递增与业务落库一起提交，失败整体回滚（允许出现号段空洞）。

    并发安全（2026-10-28 压测修复）：单语句「条件相对递增 + RETURNING」取号。
    SQLite 忽略 `with_for_update()`，旧的「SELECT 读值 → Python +1 → UPDATE 绝对值写」
    在并发建单时会让多个事务读到同一个 current_value，各自发同一个号，后提交者撞
    `orders.order_no` 唯一约束直接 500。相对递增利用 SQLite 单写锁天然串行：后到者的
    UPDATE 会等前者提交后再执行（python sqlite3 默认 busy 等待 5s），拿到的是 +1 后的值。
    上限校验放进 WHERE：超限时语句零命中、不消耗任何号，语义与旧版一致。
    """
    key_value = key.value if isinstance(key, SequenceKey) else key
    config = session.execute(
        select(DocumentSequence.prefix, DocumentSequence.padding).where(
            DocumentSequence.sequence_key == key_value
        )
    ).first()
    if config is None:
        raise Validation(
            f"编号序列 {key_value} 尚未初始化，请先执行基础种子",
            code=ErrorCode.VALIDATION_ERROR,
            details={"sequence_key": key_value},
        )
    prefix, padding = config
    max_value = 10**padding - 1
    allocated = session.execute(
        update(DocumentSequence)
        .where(
            DocumentSequence.sequence_key == key_value,
            DocumentSequence.current_value < max_value,
        )
        .values(current_value=DocumentSequence.current_value + 1)
        .returning(DocumentSequence.current_value)
    ).scalar()
    if allocated is None:
        raise Validation(
            f"编号已超出 {max_value} 上限，禁止静默进位，请联系管理员裁决",
            code=ErrorCode.SEQUENCE_EXHAUSTED,
            details={"sequence_key": key_value, "max": max_value},
        )
    return f"{prefix}{allocated:0{padding}d}"


def format_next_number(
    *, sequence_key: str, prefix: str, padding: int, current_value: int
) -> str:
    """按序列行字段拼出下一个编号（不碰数据库，纯函数）。

    `peek_number` 与列表页共用同一份格式化口径：调用方若已持有序列行，
    直接用本函数即可，无需再逐行回查数据库。
    """
    candidate = current_value + 1
    if candidate > MAX_SEQUENCE_VALUE:
        raise Validation(
            "编号已达上限",
            code=ErrorCode.SEQUENCE_EXHAUSTED,
            details={"sequence_key": sequence_key},
        )
    return f"{prefix}{candidate:0{padding}d}"


def peek_number(session: Session, key: str | SequenceKey) -> str:
    """预览下一个编号（不消耗序列），用于前端占位提示。"""
    key_value = key.value if isinstance(key, SequenceKey) else key
    row = session.scalar(
        select(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    )
    if row is None:
        raise Validation(
            f"编号序列 {key_value} 尚未初始化", details={"sequence_key": key_value}
        )
    return format_next_number(
        sequence_key=key_value,
        prefix=row.prefix,
        padding=row.padding,
        current_value=row.current_value,
    )


def current_value(session: Session, key: str | SequenceKey) -> int:
    key_value = key.value if isinstance(key, SequenceKey) else key
    row = session.scalar(
        select(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    )
    return 0 if row is None else row.current_value


def allocate_flow_no(session: Session, direction: str) -> str:
    """资金流水编号（2026-10-28 用户口径）：按方向独立递增——
    支出 ZC+五位流水（ZC00001）、收入 SR+五位流水（SR00001）。"""
    key = SequenceKey.CASHFLOW_OUT if direction == Direction.OUT.value else SequenceKey.CASHFLOW_IN
    return allocate_number(session, key)


__all__ = [
    "MAX_SEQUENCE_VALUE",
    "allocate_flow_no",
    "allocate_number",
    "current_value",
    "ensure_sequence",
    "format_next_number",
    "peek_number",
]
