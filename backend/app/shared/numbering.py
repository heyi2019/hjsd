"""shared.numbering：编号分配器（BAS-02-04）。

规则（PRD §2.1.1 / V19）：
- 纯顺序号、不含日期；主业务按类型独立递增（HS/TH/DG 可并存同号）；
- 事务内递增，取消不回收，编号永不修改、永不复用；
- padding 通常为最小位数；通知编号固定 NTF0001–NTF9999。
"""
from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.errors import ErrorCode, Validation
from app.domain.enums import Direction, SequenceKey
from app.domain.foundation import DocumentSequence

DEFAULT_PADDING = 4
NOTIFICATION_MAX = 9999


def _notification_exhausted() -> Validation:
    return Validation("通知编号已用尽，请联系管理员处理", details={"sequence_key": SequenceKey.NOTIFICATION.value, "max": NOTIFICATION_MAX})


def ensure_sequence(
    session: Session,
    key: str | SequenceKey,
    prefix: str,
    padding: int = DEFAULT_PADDING,
) -> DocumentSequence:
    """取（必要时建）编号序列；同一 key 幂等返回既有行。

    并发安全：旧版 select-then-insert 在多进程/多请求同时初始化同一 key 时
    （种子并行、订单类型初始化），各方 select 都返回 None → 各自 insert →
    后到者撞 `uq_document_sequences_key` 唯一约束直接 500。
    改为 PG `ON CONFLICT DO NOTHING` 由数据库保证同 key 只落一行，冲突即跳过，
    再统一回读；与旧版一样不改写既有行的 prefix/padding。
    """
    key_value = key.value if isinstance(key, SequenceKey) else key
    session.execute(
        pg_insert(DocumentSequence)
        .values(
            sequence_key=key_value,
            prefix=prefix,
            padding=padding,
            current_value=0,
        )
        .on_conflict_do_nothing(index_elements=["sequence_key"])
    )
    row = session.scalar(
        select(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    )
    if row is None:  # 防御：约束/方言异常下仍未落行时明确报错，不静默发号
        raise Validation(
            f"编号序列 {key_value} 初始化失败",
            details={"sequence_key": key_value},
        )
    return row


def allocate_number(session: Session, key: str | SequenceKey) -> str:
    """在当前事务内分配下一个业务编号并返回，例如 `HS0001`。

    调用方必须处于事务中：编号递增与业务落库一起提交，失败整体回滚（允许出现号段空洞）。

    并发安全（2026-10-28 压测修复）：单语句「条件相对递增 + RETURNING」取号。
    旧的「SELECT 读值 → Python +1 → UPDATE 绝对值写」在并发建单时会让多个事务读到
    同一个 current_value，各自发同一个号，后提交者撞 `orders.order_no` 唯一约束直接 500。
    改为相对递增（`current_value + 1`）后由数据库自己串行化：PG 在行锁上排队，
    后到者的 UPDATE 等前者提交后才执行，读到的是 +1 之后的值。
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
    statement = update(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    if key_value == SequenceKey.NOTIFICATION.value:
        statement = statement.where(DocumentSequence.current_value < NOTIFICATION_MAX)
    allocated = session.execute(
        statement
        .values(current_value=DocumentSequence.current_value + 1)
        .returning(DocumentSequence.current_value)
    ).scalar()
    if allocated is None:
        if key_value == SequenceKey.NOTIFICATION.value:
            raise _notification_exhausted()
        raise Validation("编号序列不存在", code=ErrorCode.VALIDATION_ERROR, details={"sequence_key": key_value})
    return f"{prefix}{allocated:0{padding}d}"


def allocate_numbers(session: Session, key: str | SequenceKey, count: int) -> list[str]:
    """在同一事务中一次分配连续编号；并发更新由序列行锁串行化。"""
    if count < 0:
        raise ValueError("编号数量不能为负数")
    if count == 0:
        return []
    key_value = key.value if isinstance(key, SequenceKey) else key
    statement = update(DocumentSequence).where(DocumentSequence.sequence_key == key_value)
    if key_value == SequenceKey.NOTIFICATION.value:
        statement = statement.where(DocumentSequence.current_value <= NOTIFICATION_MAX - count)
    config = session.execute(
        statement
        .values(current_value=DocumentSequence.current_value + count)
        .returning(DocumentSequence.prefix, DocumentSequence.padding, DocumentSequence.current_value)
    ).first()
    if config is None:
        if key_value == SequenceKey.NOTIFICATION.value and session.scalar(
            select(DocumentSequence.id).where(DocumentSequence.sequence_key == key_value)
        ) is not None:
            raise _notification_exhausted()
        raise Validation(f"编号序列 {key_value} 尚未初始化，请先执行基础种子", code=ErrorCode.VALIDATION_ERROR, details={"sequence_key": key_value})
    prefix, padding, last = config
    return [f"{prefix}{number:0{padding}d}" for number in range(last - count + 1, last + 1)]


def format_next_number(
    *, sequence_key: str, prefix: str, padding: int, current_value: int
) -> str:
    """按序列行字段拼出下一个编号（不碰数据库，纯函数）。

    `peek_number` 与列表页共用同一份格式化口径：调用方若已持有序列行，
    直接用本函数即可，无需再逐行回查数据库。
    """
    if sequence_key == SequenceKey.NOTIFICATION.value and current_value >= NOTIFICATION_MAX:
        return "已用尽"
    return f"{prefix}{current_value + 1:0{padding}d}"


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


def allocate_flow_no(session: Session, direction: str) -> str:
    """资金流水编号（2026-10-28 用户口径）：按方向独立递增——
    支出 ZC+五位流水（ZC00001）、收入 SR+五位流水（SR00001）。"""
    key = SequenceKey.CASHFLOW_OUT if direction == Direction.OUT.value else SequenceKey.CASHFLOW_IN
    return allocate_number(session, key)


__all__ = [
    "allocate_flow_no",
    "allocate_number",
    "allocate_numbers",
    "ensure_sequence",
    "format_next_number",
    "peek_number",
]
