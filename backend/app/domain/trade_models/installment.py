"""分期合约、期次计划与处置流水。"""

from __future__ import annotations

from app.domain.base import Base
from app.core.money import Amount
from app.domain.base import (
    AuditMixin,
    TimestampMixin,
)
from app.domain.enums import (
    InstallmentContractType,
    InstallmentDispositionAction,
    InstallmentStatus,
    ScheduleStatus,
)
from datetime import date
from sqlalchemy import (
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    text,
    UniqueConstraint,
)
from sqlalchemy.orm import (
    Mapped,
    mapped_column,
)

class Installment(Base, AuditMixin):
    """分期合约：同一订单允许保留取消历史，最多一份未取消合约。"""

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
        Index("uq_installments_active_order", "order_id", unique=True, postgresql_where=text("status <> 'CANCELLED'")),
        Index("ix_installments_status", "status", "first_due_on"),
        CheckConstraint(
            "principal >= 0 AND down_payment >= 0 AND service_fee >= 0 AND per_period_service_fee >= 0 AND per_period >= 0 AND paid_amount >= 0 AND waived_amount >= 0 AND bad_debt_amount >= 0",
            name="amount_nonneg",
        ),
        CheckConstraint(
            "down_payment <= principal",
            name="down_payment_lte_principal",
        ),
        CheckConstraint(
            "principal <= down_payment + per_period * periods",
            name="principal_lte_schedule_total",
        ),
        CheckConstraint("periods > 0", name="periods_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    inst_no: Mapped[str] = mapped_column(String(32), nullable=False)
    order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    contract_type: Mapped[str] = mapped_column(String(24), nullable=False)
    principal: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    down_payment: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    service_fee: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    periods: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    per_period_service_fee: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    per_period: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    final_period_adjustment: Mapped[object] = mapped_column(Amount, nullable=False, default=0, server_default=text("0"))
    paid_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    waived_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    bad_debt_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=InstallmentStatus.PENDING.value
    )
    delivered_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    first_due_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 表单字段配置体系：INVCANCEL 等作用域自定义字段值（与 Order.form_extra 同构）。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class InstallmentSchedule(Base, TimestampMixin):
    """分期计划明细：支持部分收款、逾期、减免与展期留痕。"""

    __tablename__ = "installment_schedules"
    __table_args__ = (
        CheckConstraint(
            f"status IN {ScheduleStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="schedule_status_valid",
        ),
        UniqueConstraint("installment_id", "period_no", name="uq_installment_period"),
        Index("ix_installment_schedules_due", "installment_id", "due_on", "status"),
        CheckConstraint(
            "due_amount >= 0 AND received_amount >= 0 AND waived_amount >= 0",
            name="amount_nonneg",
        ),
        CheckConstraint(
            "received_amount + waived_amount <= due_amount",
            name="settled_amount_within_due",
        ),
        CheckConstraint("period_no >= 0", name="period_no_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    installment_id: Mapped[int] = mapped_column(
        ForeignKey("installments.id", ondelete="CASCADE"), nullable=False
    )
    period_no: Mapped[int] = mapped_column(Integer, nullable=False)
    due_on: Mapped[date] = mapped_column(Date, nullable=False)
    service_fee_rate: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    due_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    received_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    waived_amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    received_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, default=ScheduleStatus.PENDING.value
    )


class InstallmentDisposition(Base, AuditMixin):
    """逾期后的账号处置事实：回收或回收后的转售。"""

    __tablename__ = "installment_dispositions"
    __table_args__ = (
        Index("ix_installment_dispositions_related_order_id", "related_order_id"),
        CheckConstraint(
            f"action IN {InstallmentDispositionAction.values()!r}".replace("[", "(").replace("]", ")"),
            name="installment_disposition_action_valid",
        ),
        UniqueConstraint("installment_id", "action", name="uq_installment_disposition_action"),
        Index("ix_installment_dispositions_account", "account_id", "occurred_on"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    installment_id: Mapped[int] = mapped_column(
        ForeignKey("installments.id", ondelete="RESTRICT"), nullable=False
    )
    account_id: Mapped[int] = mapped_column(
        ForeignKey("stocks.id", ondelete="RESTRICT"), nullable=False
    )
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    occurred_on: Mapped[date] = mapped_column(Date, nullable=False)
    related_order_id: Mapped[int | None] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True
    )
    note: Mapped[str] = mapped_column(Text, nullable=False)
