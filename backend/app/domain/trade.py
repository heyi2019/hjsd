"""domain.trade：订单、事件、现金流、账号、分期、押金、返点。

依据：《ERP_数据字典_v1.0.md》《ERP_数据库DDL与迁移方案_v1.0.md》《ERP_功能规格说明书_v1.0.md》
ORD-01/02、ACC-01、HS-01、TH-01、DG-01、DFQ-01、REB-01、FIN-01~04。

不可突破的口径：
- 订单汇总金额、账号成本、分期已收**均由事件派生**，不允许直接写（ORD-02-02）；
- 一个事件最多派生一条有效现金流（FIN-02-03），`DELIVER` 无金额、无现金流；
- 所有金额列 `DECIMAL(18,2)`，禁止 float。
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
from app.core.money import Amount
from app.domain.base import AuditMixin, TimestampMixin
from app.domain.enums import (
    AccountStatus,
    CapitalType,
    CashflowStatus,
    DepositStatus,
    Direction,
    EventType,
    InstallmentContractType,
    InstallmentStatus,
    LinkStatus,
    Nature,
    OrderStatus,
    Portion,
    RebateStatus,
    ReconciliationStatus,
    ScheduleStatus,
)


class Account(Base, AuditMixin):
    """游戏账号台账：成本由 BUY + COST 事件累计（ACC-01-04）。"""

    __tablename__ = "accounts"
    __table_args__ = (
        CheckConstraint(
            f"status IN {AccountStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="account_status_valid",
        ),
        Index("uq_accounts_inventory_no", "inventory_no", unique=True),
        UniqueConstraint("game_account", name="uq_accounts_game_account"),
        Index("ix_accounts_status", "status"),
        CheckConstraint("cost_amount >= 0", name="cost_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    inventory_no: Mapped[str] = mapped_column(String(32), nullable=False)
    game_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    business_mode: Mapped[str | None] = mapped_column(String(24), nullable=True)
    inventory_type: Mapped[str | None] = mapped_column(String(24), nullable=True)
    game_account: Mapped[str | None] = mapped_column(String(128), nullable=True)
    game_password: Mapped[str | None] = mapped_column(String(256), nullable=True)
    channel_region: Mapped[str | None] = mapped_column(String(128), nullable=True)
    bound_phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    has_secondary: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    platform: Mapped[str | None] = mapped_column(String(64), nullable=True)
    region: Mapped[str | None] = mapped_column(String(64), nullable=True)
    risk_level: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=AccountStatus.IN_STOCK.value
    )
    buy_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    cost_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    channels: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    account_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    account_images: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class Order(Base, AuditMixin):
    """订单主表：编号按业务前缀分配（HS/TH/DG/DFQ）。"""

    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint(
            f"status IN {OrderStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="order_status_valid",
        ),
        CheckConstraint(
            f"capital_type IN {CapitalType.values()!r}".replace("[", "(").replace("]", ")"),
            name="order_capital_type_valid",
        ),
        UniqueConstraint("order_no", name="uq_orders_no"),
        Index("ix_orders_type_date", "order_type", "trade_date"),
        Index("ix_orders_link_status", "link_status"),
        Index("ix_orders_trade_date", "trade_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_no: Mapped[str] = mapped_column(String(32), nullable=False)
    order_type: Mapped[str] = mapped_column(String(16), nullable=False)
    capital_type: Mapped[str] = mapped_column(String(16), nullable=False)
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    # DG 代挂结算条款：寄售登记可为空，成交前由业务补齐并固化在订单上。
    listing_price: Mapped[object | None] = mapped_column(Amount, nullable=True)
    service_fee: Mapped[object | None] = mapped_column(Amount, nullable=True)
    commission_mode: Mapped[str | None] = mapped_column(String(32), nullable=True)
    commission_payer: Mapped[str | None] = mapped_column(String(16), nullable=True)
    expected_settlement_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    # DFQ 只保留订单内的账号文本快照，不产生库存账号关联。
    account_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=OrderStatus.ACTIVE.value
    )
    # BAS-06-04 规则快照：创建时固化当时生效的规则版本与参数。
    # 「改未来费率不会改写已发生订单的利润」这条红线靠它兜底 ——
    # 规则版本改了也不回写快照，历史利润永远按当时口径。
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


class OrderEvent(Base, AuditMixin):
    """业务事件：过账后原子派生现金流，已过账事件不可改，只能冲销。"""

    __tablename__ = "order_events"
    __table_args__ = (
        CheckConstraint(
            f"event_type IN {EventType.values()!r}".replace("[", "(").replace("]", ")"),
            name="event_type_valid",
        ),
        UniqueConstraint("event_no", name="uq_order_events_no"),
        Index("ix_order_events_order", "order_id", "event_type", "occurred_on"),
        CheckConstraint("amount >= 0", name="amount_nonneg"),
        Index("ix_order_events_occurred_on", "occurred_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
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
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class Cashflow(Base, AuditMixin):
    """现金流：必属池；每笔流水可追溯到来源订单或订单事件。"""

    __tablename__ = "cashflow"
    __table_args__ = (
        CheckConstraint(
            f"nature IN {Nature.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_nature_valid",
        ),
        CheckConstraint(
            f"direction IN {Direction.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_direction_valid",
        ),
        CheckConstraint(
            f"status IN {CashflowStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_status_valid",
        ),
        UniqueConstraint("flow_no", name="uq_cashflow_no"),
        UniqueConstraint("order_event_id", name="uq_cashflow_event"),
        Index("ix_cashflow_pool_date", "pool_id", "occurred_on"),
        Index("ix_cashflow_order", "order_id"),
        Index("ix_cashflow_deposit", "deposit_id"),
        Index("ix_cashflow_nature", "nature"),
        Index("ix_cashflow_transfer", "transfer_id"),
        CheckConstraint("amount >= 0", name="amount_nonneg"),
        Index("ix_cashflow_occurred_on", "occurred_on"),
        Index("ix_cashflow_status", "status"),
        UniqueConstraint("reversal_of_id", name="uq_cashflow_reversal"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    flow_no: Mapped[str] = mapped_column(String(32), nullable=False)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False
    )
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    nature: Mapped[str] = mapped_column(String(16), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False, default="OTHER")
    direction: Mapped[str] = mapped_column(String(8), nullable=False)
    amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=CashflowStatus.APPROVED.value
    )
    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    deposit_id: Mapped[int | None] = mapped_column(
        ForeignKey("deposits.id", ondelete="SET NULL"), nullable=True
    )
    order_event_id: Mapped[int | None] = mapped_column(
        ForeignKey("order_events.id", ondelete="SET NULL"), nullable=True
    )
    transfer_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reversal_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("cashflow.id", ondelete="RESTRICT"), nullable=True
    )
    reviewed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reversal_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class Reconciliation(Base, AuditMixin):
    """按资金池、账单日和账户固化的日对账快照。"""

    __tablename__ = "reconciliations"
    __table_args__ = (
        UniqueConstraint(
            "pool_id",
            "reconciled_on",
            "account_label",
            name="uq_reconciliations_scope",
        ),
        Index("ix_reconciliations_pool_date", "pool_id", "reconciled_on"),
        CheckConstraint(
            f"status IN {ReconciliationStatus.values()!r}"
            .replace("[", "(")
            .replace("]", ")"),
            name="reconciliation_status_valid",
        ),
        CheckConstraint("statement_balance >= 0", name="reconciliation_statement_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False
    )
    reconciled_on: Mapped[date] = mapped_column(Date, nullable=False)
    account_label: Mapped[str] = mapped_column(String(128), nullable=False)
    system_balance: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    statement_balance: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    difference: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=ReconciliationStatus.OPEN.value
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    unmatched_flow_ids: Mapped[list[int]] = mapped_column(JSON, nullable=False, default=list)
    resolved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class OrderProfitAllocation(Base, TimestampMixin):
    """多人利润分配：同订单有效比例合计必须为 100%（BAS-06-03）。"""

    __tablename__ = "order_profit_allocations"
    __table_args__ = (
        UniqueConstraint("order_id", "user_id", "role", name="uq_order_profit_alloc"),
        CheckConstraint("allocation_rate >= 0", name="rate_nonneg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    allocation_rate: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )


class Installment(Base, AuditMixin):
    """分期合约：一单一合约；STOCK_SALE 仅 HS、ADVANCE_PURCHASE 仅 DFQ。"""

    __tablename__ = "installments"
    __table_args__ = (
        CheckConstraint(
            f"contract_type IN {InstallmentContractType.values()!r}"
            .replace("[", "(").replace("]", ")"),
            name="installment_contract_valid",
        ),
        CheckConstraint(
            f"status IN {InstallmentStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="installment_status_valid",
        ),
        UniqueConstraint("inst_no", name="uq_installments_no"),
        UniqueConstraint("order_id", name="uq_installments_order"),
        Index("ix_installments_status", "status", "first_due_on"),
        CheckConstraint(
            "principal >= 0 AND down_payment >= 0 AND service_fee >= 0 AND per_period_service_fee >= 0 AND per_period >= 0 AND paid_amount >= 0 AND waived_amount >= 0",
            name="amount_nonneg",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    inst_no: Mapped[str] = mapped_column(String(32), nullable=False)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    contract_type: Mapped[str] = mapped_column(String(24), nullable=False)
    # BAS-06-04 规则快照：分期利率/期数等参数在签约时固化，规则改版不回写历史合约。
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    policy_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    principal: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    down_payment: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    service_fee: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    periods: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    per_period_service_fee: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    per_period: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    paid_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    waived_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=InstallmentStatus.PENDING.value
    )
    delivery_mode: Mapped[str | None] = mapped_column(String(24), nullable=True)
    delivered_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    first_due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class InstallmentSchedule(Base, TimestampMixin):
    """分期计划明细：支持部分收款、逾期、减免与展期留痕。"""

    __tablename__ = "installment_schedules"
    __table_args__ = (
        CheckConstraint(
            f"status IN {ScheduleStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="schedule_status_valid",
        ),
        UniqueConstraint("installment_id", "period_no", name="uq_installment_period"),
        Index("ix_schedules_due", "installment_id", "due_on", "status"),
        CheckConstraint(
            "due_amount >= 0 AND received_amount >= 0 AND waived_amount >= 0",
            name="amount_nonneg",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    installment_id: Mapped[int] = mapped_column(
        ForeignKey("installments.id", ondelete="CASCADE"), nullable=False
    )
    period_no: Mapped[int] = mapped_column(Integer, nullable=False)
    due_on: Mapped[date] = mapped_column(Date, nullable=False)
    due_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    received_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    waived_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    received_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=ScheduleStatus.PENDING.value
    )


class Deposit(Base, AuditMixin):
    """押金占用：不进损益，只影响可用余额（FIN-04）。"""

    __tablename__ = "deposits"
    __table_args__ = (
        CheckConstraint(
            f"status IN {DepositStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="deposit_status_valid",
        ),
        CheckConstraint(
            "paid_amount >= 0 AND returned_amount >= 0 AND lost_amount >= 0",
            name="amount_nonneg",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False
    )
    counterparty_id: Mapped[int | None] = mapped_column(
        ForeignKey("counterparties.id", ondelete="SET NULL"), nullable=True
    )
    source_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    paid_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    returned_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    lost_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=DepositStatus.PAID.value
    )
    paid_on: Mapped[date] = mapped_column(Date, nullable=False)
    expected_release_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    released_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    lost_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class RebateRecord(Base, AuditMixin):
    """返点记录：新数据 source_order 必填，编号为订单从属号（REB-01）。"""

    __tablename__ = "rebate_records"
    __table_args__ = (
        CheckConstraint(
            f"status IN {RebateStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="rebate_status_valid",
        ),
        UniqueConstraint("rebate_no", name="uq_rebate_records_no"),
        Index("ix_rebate_source_order", "source_order_id"),
        CheckConstraint(
            "rate >= 0 AND base_amount >= 0",
            name="amount_nonneg",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rebate_no: Mapped[str] = mapped_column(String(32), nullable=False)
    source_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    channel: Mapped[str | None] = mapped_column(String(64), nullable=True)
    rate: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    base_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    # BAS-06-04 规则快照：创建时固化当时生效的规则版本与参数。
    # 「改未来费率不会改写已发生订单的利润」这条红线靠它兜底 ——
    # 规则版本改了也不回写快照，历史利润永远按当时口径。
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    policy_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    link_status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=LinkStatus.LINKED.value
    )
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, default=RebateStatus.OPEN.value
    )
    collected_on: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class RebateSettlement(Base, AuditMixin):
    """返点分次结算：净额 = 毛额 − 手续费，冲销通过反向子记录留痕。"""

    __tablename__ = "rebate_settlements"
    __table_args__ = (
        UniqueConstraint("settlement_no", name="uq_rebate_settlements_no"),
        UniqueConstraint("cashflow_id", name="uq_rebate_settlements_flow"),
        Index(
            "uq_rebate_settlements_reversal",
            "reversal_of_id",
            unique=True,
        ),
        CheckConstraint(
            "gross_amount >= 0 AND platform_fee >= 0 AND net_amount >= 0",
            name="amount_nonneg",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    settlement_no: Mapped[str] = mapped_column(String(48), nullable=False)
    rebate_record_id: Mapped[int] = mapped_column(
        ForeignKey("rebate_records.id", ondelete="RESTRICT"), nullable=False
    )
    settled_on: Mapped[date] = mapped_column(Date, nullable=False)
    gross_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    platform_fee: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    net_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    cashflow_id: Mapped[int | None] = mapped_column(
        ForeignKey("cashflow.id", ondelete="SET NULL"), nullable=True
    )
    reversal_of_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


__all__ = [
    "Account",
    "Cashflow",
    "Deposit",
    "Installment",
    "InstallmentSchedule",
    "Order",
    "OrderEvent",
    "OrderProfitAllocation",
    "RebateRecord",
    "RebateSettlement",
]
