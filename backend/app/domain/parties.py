"""domain.parties：客户、合作方、活字段与经营规则表。

依据：《ERP_数据字典_v1.0.md》《ERP_数据库DDL与迁移方案_v1.0.md》《ERP_功能规格说明书_v1.0.md》
BAS-02-05 / BAS-04 / BAS-06 / CUS-01。

- 客户 `CUS0001` 与合作方 `CP0001` **编号域独立**，两类对象不得混用（V20）；
- 联系方式**非唯一**，重名/同号只产生重复候选，不拦截建档（CUS-01-05）；
- 停用 / 已合并对象不可作为**新**订单参与方，历史关系保留；
- 活字段 `entity_type=customer` 仅承载辅助信息，不得覆盖核算字段（BAS-04）。
"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.domain.base import AuditMixin, TimestampMixin
from app.domain.enums import (
    CounterpartyStatus,
    CounterpartyType,
    CustomerRole,
    CustomerStatus,
    EntityType,
    PolicyStatus,
    CounterpartyRole,
)


# ------------------------------------------------------------------ 经营规则
class PolicyDefinition(Base, AuditMixin):
    """经营规则定义（BAS-06）：定义类型与范围，不保存业务快照。"""

    __tablename__ = "policy_definitions"
    __table_args__ = (
        CheckConstraint(
            f"status IN {PolicyStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="policy_status_valid",
        ),
        UniqueConstraint(
            "policy_code", "scope_type", "scope_id",
            name="uq_policy_definitions_scope_code",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    policy_code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(32), nullable=False, default="GLOBAL")
    scope_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=PolicyStatus.DRAFT.value
    )


class PolicyVersion(Base, AuditMixin):
    """规则版本：已被引用不可更新或删除，只能新建版本（BAS-06-02）。"""

    __tablename__ = "policy_versions"
    __table_args__ = (
        UniqueConstraint(
            "policy_definition_id", "version", "effective_from",
            name="uq_policy_versions_scope",
        ),
        CheckConstraint(
            f"status IN {PolicyStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="policy_version_status_valid",
        ),
        CheckConstraint("version > 0", name="version_positive"),
        CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="effective_range_valid",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    policy_definition_id: Mapped[int] = mapped_column(
        ForeignKey("policy_definitions.id", ondelete="RESTRICT"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    config: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=PolicyStatus.DRAFT.value
    )
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


# ------------------------------------------------------------------ 活字段
class FieldDefinition(Base, AuditMixin):
    """活字段定义：有历史值只能停用，不可删除（BAS-04-03）。"""

    __tablename__ = "field_definitions"
    __table_args__ = (
        CheckConstraint(
            f"entity_type = '{EntityType.CUSTOMER.value}'",
            name="field_entity_valid",
        ),
        UniqueConstraint("entity_type", "field_key", name="uq_field_definitions_key"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    field_key: Mapped[str] = mapped_column(String(64), nullable=False)
    label: Mapped[str] = mapped_column(String(128), nullable=False)
    field_type: Mapped[str] = mapped_column(String(16), nullable=False, default="TEXT")
    options: Mapped[list | None] = mapped_column(JSON, nullable=True)
    required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class EntityExtraValue(Base, TimestampMixin):
    """活字段值：只存辅助信息，不参与核算（BAS-04-04）。"""

    __tablename__ = "entity_extra_values"
    __table_args__ = (
        UniqueConstraint(
            "entity_type", "entity_id", "field_definition_id",
            name="uq_entity_extra_values_unique",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    field_definition_id: Mapped[int] = mapped_column(
        ForeignKey("field_definitions.id", ondelete="RESTRICT"), nullable=False
    )
    value: Mapped[dict | None] = mapped_column(JSON, nullable=True)


# ------------------------------------------------------------------ 客户
class Customer(Base, AuditMixin):
    """客户主数据：编号 `CUS0001`，不可改、不可复用。"""

    __tablename__ = "customers"
    __table_args__ = (
        CheckConstraint(
            f"status IN {CustomerStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="customer_status_valid",
        ),
        UniqueConstraint("customer_no", name="uq_customers_no"),
        Index("ix_customers_phone", "phone"),
        Index("ix_customers_wechat", "wechat"),
        Index("ix_customers_qq", "qq"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_no: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    wechat: Mapped[str | None] = mapped_column(String(128), nullable=True)
    qq: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=CustomerStatus.ACTIVE.value
    )
    tags: Mapped[list | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    merged_into_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), nullable=True
    )
    merged_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class Counterparty(Base, AuditMixin):
    """合作方主数据：同行 / 供货方 / 平台，编号 `CP0001`，与客户分离。"""

    __tablename__ = "counterparties"
    __table_args__ = (
        CheckConstraint(
            f"type IN {CounterpartyType.values()!r}".replace("[", "(").replace("]", ")"),
            name="counterparty_type_valid",
        ),
        CheckConstraint(
            f"status IN {CounterpartyStatus.values()!r}"
            .replace("[", "(").replace("]", ")"),
            name="counterparty_status_valid",
        ),
        UniqueConstraint("counterparty_no", name="uq_counterparties_no"),
        Index("ix_counterparties_type_status", "type", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    counterparty_no: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(String(128), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    wechat: Mapped[str | None] = mapped_column(String(128), nullable=True)
    qq: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=CounterpartyStatus.ACTIVE.value
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


# ------------------------------------------------------------------ 订单参与方
class OrderCustomerRole(Base, TimestampMixin):
    """订单客户角色：同一订单同一客户同一角色仅一条（CUS-01-04）。"""

    __tablename__ = "order_customer_roles"
    __table_args__ = (
        CheckConstraint(
            f"role IN {CustomerRole.values()!r}".replace("[", "(").replace("]", ")"),
            name="customer_role_valid",
        ),
        UniqueConstraint("order_id", "customer_id", "role", name="uq_order_customer_role"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)


class OrderCounterpartyRole(Base, TimestampMixin):
    """订单合作方角色：TH 同行、DFQ 供货方、DG 平台由此关联。"""

    __tablename__ = "order_counterparty_roles"
    __table_args__ = (
        CheckConstraint(
            f"role IN {CounterpartyRole.values()!r}".replace("[", "(").replace("]", ")"),
            name="counterparty_role_valid",
        ),
        UniqueConstraint(
            "order_id", "counterparty_id", "role", name="uq_order_counterparty_role"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    counterparty_id: Mapped[int] = mapped_column(
        ForeignKey("counterparties.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)


__all__ = [
    "Counterparty",
    "Customer",
    "EntityExtraValue",
    "FieldDefinition",
    "OrderCounterpartyRole",
    "OrderCustomerRole",
    "PolicyDefinition",
    "PolicyVersion",
]
