"""订单主档、订单关联、订单事件（ORD-01/02）。"""

from __future__ import annotations

from app.core.database import Base
from app.core.money import Amount
from app.core.time import now_second
from app.domain.base import (
    AuditMixin,
    TimestampMixin,
)
from app.domain.enums import (
    CommissionMode,
    CommissionPayer,
    DeliveryMode,
    EventType,
    LinkStatus,
    OrderLinkType,
    OrderStatus,
    Portion,
)
from datetime import (
    date,
    datetime,
)
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import (
    Mapped,
    mapped_column,
)

class Order(Base, AuditMixin):
    """订单主表：编号按业务前缀分配（HS/TH/DG）。"""

    __tablename__ = "orders"
    __table_args__ = (
        Index("ix_orders_owner_id", "owner_id"),
        Index("ix_orders_policy_version_id", "policy_version_id"),
        Index("ix_orders_account_id", "account_id"),
        CheckConstraint(
            f"status IN {OrderStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="order_status_valid",
        ),
        UniqueConstraint("order_no", name="uq_orders_no"),
        Index("ix_orders_type_date", "order_type", "trade_date"),
        Index("ix_orders_link_status", "link_status"),
        Index("ix_orders_trade_date", "trade_date"),
        CheckConstraint(
            f"link_status IN {LinkStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="order_link_status_valid",
        ),
        CheckConstraint(
            f"commission_mode IS NULL OR commission_mode IN {CommissionMode.values()!r}",
            name="order_commission_mode_valid",
        ),
        CheckConstraint(
            f"commission_payer IS NULL OR commission_payer IN {CommissionPayer.values()!r}",
            name="order_commission_payer_valid",
        ),
        CheckConstraint(
            "(commission_mode IS NULL) = (commission_payer IS NULL)",
            name="order_commission_pair_valid",
        ),
        CheckConstraint(
            "order_type = 'DG' OR (commission_mode IS NULL AND commission_payer IS NULL)",
            name="order_commission_type_valid",
        ),
        CheckConstraint(
            "account_snapshot IS NULL OR CAST(account_snapshot AS TEXT) = 'null' "
            "OR order_type IN ('HS', 'TH', 'DG')",
            name="order_account_snapshot_type_valid",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_no: Mapped[str] = mapped_column(String(32), nullable=False)
    order_type: Mapped[str] = mapped_column(String(16), nullable=False)
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    # listing_price / service_fee / expected_settlement_date 已删除（0024）：
    # ORM 有定义但 schema 从未暴露、前端零引用、486 行全 NULL 的死列；
    # 分期场景的 service_fee 走 installments.service_fee（活列），勿混淆。
    commission_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    commission_payer: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # HS/TH/DG 建单时的账号文本快照统一存于 account_snapshot。
    account_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("stocks.id", ondelete="SET NULL"), nullable=True
    )
    # 2026-10-28 去冗余：HS/TH/DG 账号资料统一存 account_snapshot（单一事实源），
    # 原平铺列（game_type/game_account/game_password/channel_region/bound_phone/
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=OrderStatus.ACTIVE.value
    )
    # BAS-06-04 规则快照：创建时固化当时生效的规则版本与参数。
    # 「改未来费率不会改写已发生订单的利润」这条红线靠它兜底 ——
    # 规则版本改动不回写快照，利润按订单生成时的口径计算。
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    policy_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    link_status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=LinkStatus.LINKED.value
    )
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 建单表单「自定义字段」值存放处（与统一表单字段配置解耦，不违反治理约束）。
    # key 为 OrderFormField.field_key，value 为按 field_type 归一化后的值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # #15 需求2：登记时间（系统时间戳，台账展示为「订单创建时间」）可改可清空删除，
    # 故在此覆盖 TimestampMixin 的 created_at 为可空；插入仍由 server_default 兜底，
    # 仅「清空」动作可显式置 NULL。updated_at 保持非空（仍来自 TimestampMixin）。
    created_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True, default=now_second, server_default=func.now()
    )


class OrderLink(Base, TimestampMixin):
    """订单上下游关联与拆分份额（ORD-01-05）。"""

    __tablename__ = "order_links"
    __table_args__ = (
        UniqueConstraint(
            "source_order_id", "target_order_id", name="uq_order_links_pair"
        ),
        CheckConstraint("source_order_id <> target_order_id", name="order_link_not_self"),
        CheckConstraint(
            f"relation_type IN {OrderLinkType.values()!r}".replace("[", "(").replace("]", ")"),
            name="order_link_type_valid",
        ),
        CheckConstraint(
            "split_ratio IS NULL OR (split_ratio > 0 AND split_ratio <= 100)",
            name="order_link_ratio_valid",
        ),
        CheckConstraint("split_amount IS NULL OR split_amount > 0", name="order_link_amount_valid"),
        Index("ix_order_links_source", "source_order_id"),
        Index("ix_order_links_target", "target_order_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    target_order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    # 保留创建时的方向语义，查询时也会按当前订单返回 direction。
    relation_type: Mapped[str] = mapped_column(String(16), nullable=False)
    split_ratio: Mapped[object | None] = mapped_column(Amount, nullable=True)
    split_amount: Mapped[object | None] = mapped_column(Amount, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 表单字段配置体系：ORDERLINK 作用域自定义字段值（与 Order.form_extra 同构）。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")
    updated_by: Mapped[str] = mapped_column(String(64), nullable=False, default="system")


class OrderEvent(Base, AuditMixin):
    """业务事件：登记后原子派生现金流，已登记事件不可改，只能冲销。"""

    __tablename__ = "order_events"
    __table_args__ = (
        Index("ix_order_events_pool_id", "pool_id"),
        Index("ix_order_events_offset_event_id", "offset_event_id"),
        CheckConstraint(
            f"event_type IN {EventType.values()!r}".replace("[", "(").replace("]", ")"),
            name="event_type_valid",
        ),
        CheckConstraint(
            f"portion IN {Portion.values()!r}".replace("[", "(").replace("]", ")"),
            name="portion_valid",
        ),
        UniqueConstraint("event_no", name="uq_order_events_no"),
        Index("ix_order_events_order", "order_id", "event_type", "occurred_on"),
        CheckConstraint("amount >= 0", name="amount_nonneg"),
        CheckConstraint(
            f"delivery_mode IS NULL OR delivery_mode IN {DeliveryMode.values()!r}",
            name="event_delivery_mode_valid",
        ),
        Index("ix_order_events_occurred_on", "occurred_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    operator_user_ids: Mapped[list[int] | None] = mapped_column(JSON, nullable=True)
    event_no: Mapped[str] = mapped_column(String(32), nullable=False)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(String(16), nullable=False)
    amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    portion: Mapped[str] = mapped_column(
        String(16), nullable=False, default=Portion.GROSS.value
    )
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    pool_id: Mapped[int | None] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=True
    )
    offset_event_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_events.id", ondelete="SET NULL"), nullable=True
    )
    delivery_mode: Mapped[str | None] = mapped_column(String(24), nullable=True)
    is_posted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    posted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    refund_responsibility: Mapped[str | None] = mapped_column(String(32), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 表单字段配置体系：订单操作类作用域（ORDERCANC/REFUND/INVREFUND/INVOID 等）
    # 的自定义字段值（与 Order.form_extra 同构）。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
