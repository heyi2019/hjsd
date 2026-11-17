"""现金流、对账与利润分配（FIN-01~04）。"""

from __future__ import annotations

from app.core.database import Base
from app.core.money import Amount
from app.domain.base import (
    AuditMixin,
    TimestampMixin,
)
from app.domain.enums import (
    AccountingAttribute,
    AllocationRole,
    CashflowLedgerType,
    CashflowSourceType,
    Direction,
    Nature,
    ReconciliationStatus,
)
from datetime import (
    date,
    datetime,
)
from sqlalchemy import (
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
)
from sqlalchemy.orm import (
    Mapped,
    mapped_column,
)

class Cashflow(Base, AuditMixin):
    """现金流：必属池；每笔流水可追溯到来源订单或订单事件。"""

    __tablename__ = "cashflow"
    __table_args__ = (
        CheckConstraint(
            f"nature IN {Nature.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_nature_valid",
        ),
        CheckConstraint(
            f"ledger_type IN {CashflowLedgerType.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_ledger_type_valid",
        ),
        CheckConstraint(
            f"accounting_attribute IN {AccountingAttribute.values()!r}"
            .replace("[", "(")
            .replace("]", ")"),
            name="cashflow_accounting_attribute_valid",
        ),
        CheckConstraint(
            f"direction IN {Direction.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_direction_valid",
        ),
        CheckConstraint(
            "nature != 'INTERNAL' OR "
            "(source_type = 'TRANSFER' AND source_id IS NOT NULL)",
            name="internal_transfer_source_valid",
        ),
        CheckConstraint(
            "(nature = 'INTERNAL' AND source_type = 'TRANSFER' AND source_id IS NOT NULL) OR "
            "(direction = 'IN' AND nature IN ('EXTERNAL_IN', 'BUSINESS_IN')) OR "
            "(direction = 'OUT' AND nature = 'BUSINESS_OUT') OR "
            "(category = 'CANCEL' AND nature = 'BUSINESS_IN' AND direction IN ('IN', 'OUT'))",
            name="cashflow_direction_nature_valid",
        ),
        UniqueConstraint("flow_no", name="uq_cashflow_no"),
        # 一笔订单事件可派生多笔资金流水（如售出拆分进不同资金账户）。
        Index("ix_cashflow_pool_date", "pool_id", "occurred_on"),
        Index("ix_cashflow_order", "order_id"),
        Index("ix_cashflow_source", "source_type", "source_id"),
        Index("ix_cashflow_nature", "nature"),
        Index("ix_cashflow_ledger_type", "ledger_type"),
        Index("ix_cashflow_accounting_attribute", "accounting_attribute"),
        CheckConstraint("amount >= 0", name="amount_nonneg"),
        Index("ix_cashflow_occurred_on", "occurred_on"),
        CheckConstraint(
            f"source_type IN {CashflowSourceType.values()!r}".replace("[", "(").replace("]", ")"),
            name="cashflow_source_type_valid",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    flow_no: Mapped[str] = mapped_column(String(32), nullable=False)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False
    )
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    nature: Mapped[str] = mapped_column(String(16), nullable=False)
    ledger_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default=CashflowLedgerType.BUSINESS.value,
        server_default=CashflowLedgerType.BUSINESS.value,
    )
    accounting_attribute: Mapped[str] = mapped_column(
        String(32), nullable=False, default=AccountingAttribute.OPERATING_EXPENSE.value,
        server_default=AccountingAttribute.OPERATING_EXPENSE.value,
    )
    category: Mapped[str] = mapped_column(String(32), nullable=False, default="OTHER")
    direction: Mapped[str] = mapped_column(String(8), nullable=False)
    amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    source_type: Mapped[str] = mapped_column(
        String(24), nullable=False, default=CashflowSourceType.MANUAL.value,
        server_default=CashflowSourceType.MANUAL.value,
    )
    source_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reversal_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 表单字段配置体系：工作室（STUDIOEXP/STUDIOREJ/STUDIOREV）等自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    # 与订单业务事件一致：资金登记可指定一个或多个实际操作人。
    operator_user_ids: Mapped[list[int] | None] = mapped_column(JSON, nullable=True)


class Reconciliation(Base, AuditMixin):
    """按资金账户、账单日和账户固化的日对账快照。"""

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
        CheckConstraint(
            # 容差 0.005（半分）：SQLite 无 DECIMAL，Amount 落库即 REAL，严格等式
            # 对角分不为零的余额组合必然浮点残差 IntegrityError（0.30-0.10≠0.20）。
            # 真实口径偏差只可能是 0 或 >=0.01，半分窗口不会误放行。
            "abs(difference - (statement_balance - system_balance)) <= 0.005",
            name="difference_matches_balances",
        ),
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
    # FUNDRECON 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class OrderProfitAllocation(Base, TimestampMixin):
    """多人利润分配：同订单有效比例合计必须为 100%（BAS-06-03）。"""

    __tablename__ = "order_profit_allocations"
    __table_args__ = (
        Index("ix_order_profit_allocations_policy_version_id", "policy_version_id"),
        Index("ix_order_profit_allocations_user_id", "user_id"),
        UniqueConstraint("order_id", "allocation_type", "user_id", "role", name="uq_order_profit_alloc"),
        CheckConstraint(
            f"role IN {AllocationRole.values()!r}".replace("[", "(").replace("]", ")"),
            name="allocation_role_valid",
        ),
        CheckConstraint("allocation_rate >= 0", name="rate_nonneg"),
        CheckConstraint("allocation_rate <= 100", name="rate_max"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    allocation_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    allocation_rate: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    # 按金额分润：与 allocation_rate 互斥（二者都为选填，填哪个用哪个）。
    # 可为负：亏损单按金额分润时存负数，表示该人分担的亏损额（利润 -1000、填 -300）。
    # 报表取数口径：allocation_amount != 0 时直接作为该人的应付基数，
    # 否则回退 利润 × allocation_rate / 100。判据用 != 而非 > 0，否则负金额会被
    # 误判成「未填」而回退比例，亏损分润就算错。
    allocation_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    policy_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="SET NULL"), nullable=True
    )
