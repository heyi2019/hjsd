"""domain.parties：客户、合作方、表单扩展字段与经营规则表。

表结构以本模块 ORM 定义为准，与 `alembic/squashed_versions` 基线保持同步。
功能编号：BAS-02-05 / BAS-04 / BAS-06 / CUS-01。

- 客户 `CUS0001` 与合作方 `CP0001` **编号域独立**，两类对象不得混用（V20）；
- 联系方式**非唯一**，重名/同号只产生重复候选，不拦截建档（CUS-01-05）；
- 停用 / 已合并对象不可作为**新**订单参与方，历史关系保留；
- 表单扩展字段覆盖订单、账号、客户、分期、资金账户、资金流水、需求和合作方，
  仅承载辅助信息，不得覆盖核算字段（BAS-04）。
"""
from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    JSON,
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

from app.domain.base import Base
from app.domain.base import AuditMixin, TimestampMixin
from app.core.money import Amount
from app.domain.enums import (
    CounterpartyStatus,
    CounterpartyType,
    CustomerRole,
    CustomerStatus,
    LeadStatus,
    LeadType,
    PolicyStatus,
    PolicyScopeType,
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
        CheckConstraint(
            f"scope_type IN {PolicyScopeType.values()!r}".replace("[", "(").replace("]", ")"),
            name="policy_scope_type_valid",
        ),
        CheckConstraint(
            "(scope_type = 'GLOBAL' AND scope_id IS NULL) OR "
            "(scope_type <> 'GLOBAL' AND scope_id IS NOT NULL)",
            name="policy_scope_link_valid",
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


# ------------------------------------------------------------------ 客户
class Customer(Base, AuditMixin):
    """客户主数据：编号 `CUS0001`，不可改、不可复用。"""

    __tablename__ = "customers"
    __table_args__ = (
        Index("ix_customers_owner_id", "owner_id"),
        Index("ix_customers_merged_into_id", "merged_into_id"),
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
    # 扩展字段值：键取自「客户建档」表单的自定义字段（order_form_fields / CUSTOMER），
    # 与订单 Order.form_extra 同构，一实体一行存值，不再单独建值表（BAS-04）。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    merged_into_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), nullable=True
    )
    merged_reason: Mapped[str | None] = mapped_column(Text, nullable=True)


class CustomerLead(Base, AuditMixin):
    """客户需求池：只记录跟进事实，不自动生成订单或资金流水。"""

    __tablename__ = "customer_leads"
    __table_args__ = (
        Index("ix_customer_leads_converted_order_id", "converted_order_id"),
        CheckConstraint(
            f"request_type IN {LeadType.values()!r}".replace("[", "(").replace("]", ")"),
            name="lead_type_valid",
        ),
        CheckConstraint(
            f"status IN {LeadStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="lead_status_valid",
        ),
        CheckConstraint("budget IS NULL OR budget >= 0", name="lead_budget_nonneg"),
        UniqueConstraint("lead_no", name="uq_customer_leads_no"),
        Index("ix_customer_leads_customer_status", "customer_id", "status"),
        Index("ix_customer_leads_owner_status", "owner_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    lead_no: Mapped[str] = mapped_column(String(32), nullable=False)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    request_type: Mapped[str] = mapped_column(String(32), nullable=False)
    budget: Mapped[object | None] = mapped_column(Amount, nullable=True)
    target: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=LeadStatus.OPEN.value
    )
    owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    converted_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    closed_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # LEAD/LEADCLOSE/LEADCONVERT 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


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
    # COUNTERPARTY 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


# ------------------------------------------------------------------ 订单参与方
class OrderCustomerRole(Base, TimestampMixin):
    """订单客户角色：同一订单同一客户同一角色仅一条（CUS-01-04）。"""

    __tablename__ = "order_customer_roles"
    __table_args__ = (
        Index("ix_order_customer_roles_customer_id", "customer_id"),
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
    """订单合作方角色：TH 同行、DG 平台由此关联。"""

    __tablename__ = "order_counterparty_roles"
    __table_args__ = (
        Index("ix_order_counterparty_roles_counterparty_id", "counterparty_id"),
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
    "CustomerLead",
    "OrderCounterpartyRole",
    "OrderCustomerRole",
    "PolicyDefinition",
    "PolicyVersion",
]
