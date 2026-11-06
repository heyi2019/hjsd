"""domain.foundation：M0 底座表（SYS-01-01 / BAS-02 / BAS-03）。

表：`pools`、`order_type_defs`、`order_type_pools`、`document_sequences`、`audit_logs`。
表结构以本模块 ORM 定义为准：

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
from app.core.time import now_second
from app.domain.base import AuditMixin, TimestampMixin
from app.domain.enums import PoolOwnership, PoolStatus, PoolType, Portion


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


class OrderTypeDef(Base, AuditMixin):
    """业务类型主数据：首批 HS/TH/DG，可自由新增（BAS-02-02）。"""

    __tablename__ = "order_type_defs"
    __table_args__ = (
        CheckConstraint("sort_order >= 0", name="order_type_sort_order_nonnegative"),
        UniqueConstraint("code", name="uq_order_type_defs_code"),
        UniqueConstraint("sequence_prefix", name="uq_order_type_defs_sequence_prefix"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(16), nullable=False)  # 不可更新
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    sequence_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    sequence_key: Mapped[str] = mapped_column(String(64), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    routes: Mapped[list["OrderTypePool"]] = relationship(
        back_populates="order_type", cascade="all, delete-orphan"
    )


class GameTypeOption(Base, AuditMixin):
    """游戏类型标准：供订单/账号录入使用的可搜索主数据。"""

    __tablename__ = "game_type_options"
    __table_args__ = (
        CheckConstraint("sort_order >= 0", name="game_type_sort_order_nonnegative"),
        UniqueConstraint("name", name="uq_game_type_options_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    channel_regions: Mapped[list | None] = mapped_column(JSON, nullable=True)

class OrderTypePool(Base, TimestampMixin):
    """业务↔资金池路由；按业务和份额区分默认池（BAS-03-02）。"""

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
    """编号序列表：事务内递增，超出位数上限即报 `SEQUENCE_EXHAUSTED`（BAS-02-04）。

    位数上限 6 位（2026-10-28 放宽：资金流水按方向五位流水 ZC00001/SR00001）；
    实际上限按 padding 计算（10^padding - 1），见 core.numbering。
    """

    __tablename__ = "document_sequences"
    __table_args__ = (
        UniqueConstraint("sequence_key", name="uq_document_sequences_key"),
        CheckConstraint("padding > 0", name="padding_positive"),
        CheckConstraint("padding <= 6", name="padding_max"),
        CheckConstraint("current_value >= 0", name="current_value_nonneg"),
        CheckConstraint("current_value <= 999999", name="current_value_max"),
        CheckConstraint("length(trim(sequence_key)) > 0", name="sequence_key_nonempty"),
        CheckConstraint("length(trim(prefix)) > 0", name="prefix_nonempty"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sequence_key: Mapped[str] = mapped_column(String(64), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    padding: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    current_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)




class AuditLog(Base):
    """受控操作审计日志：只追加，禁止编辑与删除（BAS-05-03）。"""

    __tablename__ = "audit_logs"
    __table_args__ = (
        # 审计页按「对象类型 + 对象 ID」查轨迹，并按动作 / 操作人 / 时间筛选。
        # 该表只追加、增长最快，缺索引时每次查询都是全表扫描（2026-10-26 补齐）。
        Index("ix_audit_logs_entity", "entity_type", "entity_id", "id"),
        Index("ix_audit_logs_action", "action"),
        Index("ix_audit_logs_actor", "actor"),
        Index("ix_audit_logs_occurred_at", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=now_second, server_default=func.now()
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
    "GameTypeOption",
    "OrderTypeDef",
    "OrderTypePool",
    "Pool",
]
