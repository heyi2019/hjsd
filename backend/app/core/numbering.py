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
from app.domain.enums import SequenceKey
from app.domain.foundation import DocumentSequence

MAX_SEQUENCE_VALUE = 9999
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
    """
    key_value = key.value if isinstance(key, SequenceKey) else key
    row = session.scalar(
        # PostgreSQL 等支持行锁的数据库上，防止并发建单读到同一个 current_value；
        # SQLite 会忽略 FOR UPDATE，但仍由其写事务串行化保证单库开发环境行为。
        select(DocumentSequence)
        .where(DocumentSequence.sequence_key == key_value)
        .with_for_update()
    )
    if row is None:
        raise Validation(
            f"编号序列 {key_value} 尚未初始化，请先执行基础种子",
            code=ErrorCode.VALIDATION_ERROR,
            details={"sequence_key": key_value},
        )
    next_value = row.current_value + 1
    if next_value > MAX_SEQUENCE_VALUE:
        raise Validation(
            f"编号已超出 {MAX_SEQUENCE_VALUE} 上限，禁止静默进位，请联系管理员裁决",
            code=ErrorCode.SEQUENCE_EXHAUSTED,
            details={"sequence_key": key_value, "max": MAX_SEQUENCE_VALUE},
        )
    session.execute(
        update(DocumentSequence)
        .where(DocumentSequence.id == row.id)
        .values(current_value=next_value)
    )
    session.flush()
    return f"{row.prefix}{next_value:0{row.padding}d}"


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
    candidate = row.current_value + 1
    if candidate > MAX_SEQUENCE_VALUE:
        raise Validation(
            "编号已达上限",
            code=ErrorCode.SEQUENCE_EXHAUSTED,
            details={"sequence_key": key_value},
        )
    return f"{row.prefix}{candidate:0{row.padding}d}"


def current_value(session: Session, key: str | SequenceKey) -> int:
    key_value = key.value if isinstance(key, SequenceKey) else key
    row = session.scalar(
        select(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    )
    return 0 if row is None else row.current_value


__all__ = [
    "MAX_SEQUENCE_VALUE",
    "allocate_number",
    "current_value",
    "ensure_sequence",
    "peek_number",
]
