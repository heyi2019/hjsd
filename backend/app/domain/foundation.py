"""domain.foundation：M0 底座表（SYS-01-01 / BAS-02 / BAS-03）。

表：`pools`、`order_type_defs`、`order_type_pools`、`document_sequences`、`audit_logs`。
严格依据《ERP_数据字典_v1.0.md》《ERP_数据库DDL与迁移方案_v1.0.md》：

- `pools.code` 创建后不可改（V18）；有流水只能停用不能删（V17）；
- `ownership` 决定是否计入权益（V30）；
- 业务↔池多对多路由（V33），禁止在订单层写死回款池（V29）；
- 编号由 `document_sequences` 事务内递增，创建后不可改、不可复用（V19）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Index,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.core.money import Amount
from app.domain.base import AuditMixin, TimestampMixin
from app.domain.enums import CapitalType, PoolOwnership, PoolStatus, PoolType, Portion


class Pool(Base, AuditMixin):
    """资金池主数据：可自由创建，新增池无需改代码（PRD §1.2）。"""

    __tablename__ = "pools"
    __table_args__ = (
        CheckConstraint(
            f"ownership IN {PoolOwnership.values()!r}".replace("[", "(").replace("]", ")"),
            name="ownership_valid",
        ),
        CheckConstraint(
            f"status IN {PoolStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="status_valid",
        ),
        UniqueConstraint("code", name="uq_pools_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64), nullable=False)  # 不可更新
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    pool_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default=PoolType.OTHER.value
    )
    ownership: Mapped[str] = mapped_column(
        String(16), nullable=False, default=PoolOwnership.OWNED.value
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=PoolStatus.ACTIVE.value
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    routes: Mapped[list["OrderTypePool"]] = relationship(
        back_populates="pool", cascade="all, delete-orphan"
    )


class PoolAccount(Base, AuditMixin):
    """资金池下的实际账户；停用只阻止新流水关联，不删除历史。"""

    __tablename__ = "pool_accounts"
    __table_args__ = (
        CheckConstraint("account_type IN ('BANK', 'CASH', 'THIRD_PARTY')", name="pool_account_type_valid"),
        CheckConstraint(
            f"ownership IN {PoolOwnership.values()!r}".replace("[", "(").replace("]", ")"),
            name="pool_account_ownership_valid",
        ),
        CheckConstraint("status IN ('ACTIVE', 'DISABLED')", name="pool_account_status_valid"),
        CheckConstraint("opening_balance >= 0", name="pool_account_opening_balance_nonnegative"),
        UniqueConstraint("account_no", name="uq_pool_accounts_account_no"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pool_id: Mapped[int] = mapped_column(ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False, index=True)
    account_no: Mapped[str] = mapped_column(String(64), nullable=False)
    account_name: Mapped[str] = mapped_column(String(128), nullable=False)
    account_type: Mapped[str] = mapped_column(String(16), nullable=False)
    ownership: Mapped[str] = mapped_column(String(16), nullable=False, default=PoolOwnership.OWNED.value)
    opening_balance: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ACTIVE")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class OrderTypeDef(Base, AuditMixin):
    """业务类型主数据：首批 HS/TH/DG/DFQ，可自由新增（BAS-02-02）。"""

    __tablename__ = "order_type_defs"
    __table_args__ = (
        CheckConstraint(
            f"capital_type IN {CapitalType.values()!r}".replace("[", "(").replace("]", ")"),
            name="capital_type_valid",
        ),
        CheckConstraint("sort_order >= 0", name="order_type_sort_order_nonnegative"),
        UniqueConstraint("code", name="uq_order_type_defs_code"),
        UniqueConstraint("sequence_prefix", name="uq_order_type_defs_sequence_prefix"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(16), nullable=False)  # 不可更新
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    capital_type: Mapped[str] = mapped_column(String(16), nullable=False)
    sequence_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    sequence_key: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    routes: Mapped[list["OrderTypePool"]] = relationship(
        back_populates="order_type", cascade="all, delete-orphan"
    )


class OrderTypePool(Base, TimestampMixin):
    """业务↔资金池多对多路由；同一业务同一份额仅一条有效默认路由（BAS-03-02）。"""

    __tablename__ = "order_type_pools"
    __table_args__ = (
        Index("ix_order_type_pools_pool_id", "pool_id"),
        CheckConstraint(
            f"portion IN {Portion.values()!r}".replace("[", "(").replace("]", ")"),
            name="portion_valid",
        ),
        CheckConstraint("priority >= 0", name="route_priority_nonnegative"),
        UniqueConstraint("order_type_id", "portion", name="uq_order_type_pools_route"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_type_id: Mapped[int] = mapped_column(
        ForeignKey("order_type_defs.id", ondelete="CASCADE"), nullable=False
    )
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False
    )
    portion: Mapped[str] = mapped_column(String(16), nullable=False)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    order_type: Mapped[OrderTypeDef] = relationship(back_populates="routes")
    pool: Mapped[Pool] = relationship(back_populates="routes")


class DocumentSequence(Base, TimestampMixin):
    """编号序列表：事务内递增，超出 4 位即报 `SEQUENCE_EXHAUSTED`（BAS-02-04）。"""

    __tablename__ = "document_sequences"
    __table_args__ = (
        UniqueConstraint("sequence_key", name="uq_document_sequences_key"),
        CheckConstraint("padding > 0", name="padding_positive"),
        CheckConstraint("padding <= 4", name="padding_max"),
        CheckConstraint("current_value >= 0", name="current_value_nonneg"),
        CheckConstraint("current_value <= 9999", name="current_value_max"),
        CheckConstraint("length(trim(sequence_key)) > 0", name="sequence_key_nonempty"),
        CheckConstraint("length(trim(prefix)) > 0", name="prefix_nonempty"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sequence_key: Mapped[str] = mapped_column(String(64), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    padding: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    current_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class PeriodLock(Base, AuditMixin):
    """会计月份锁定：锁定后该月业务事实不可新增或审核。"""

    __tablename__ = "period_locks"
    __table_args__ = (
        CheckConstraint(
            "length(period) = 7 AND substr(period, 5, 1) = '-'",
            name="period_lock_format_valid",
        ),
        UniqueConstraint("period", name="uq_period_locks_period"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    period: Mapped[str] = mapped_column(String(7), nullable=False)
    locked_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    locked_by: Mapped[str] = mapped_column(String(64), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class AuditLog(Base):
    """受控操作审计日志：只追加，禁止编辑与删除（BAS-05-03）。"""

    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    actor: Mapped[str] = mapped_column(String(64), nullable=False, default="system")
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    before_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


__all__ = [
    "AuditLog",
    "DocumentSequence",
    "OrderTypeDef",
    "PeriodLock",
    "OrderTypePool",
    "Pool",
    "PoolAccount",
]
