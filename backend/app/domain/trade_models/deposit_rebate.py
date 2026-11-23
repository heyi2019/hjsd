"""押金与返点（DG-01、REB-01）。"""

from __future__ import annotations

from app.domain.base import Base
from app.core.money import Amount
from app.domain.base import AuditMixin
from app.domain.enums import (
    CashflowLedgerType,
    DepositStatus,
    RebateType,
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
    UniqueConstraint,
)
from sqlalchemy.orm import (
    Mapped,
    mapped_column,
)

class Deposit(Base, AuditMixin):
    """押金占用：不进损益，只影响可用余额（FIN-04）。"""

    __tablename__ = "deposits"
    __table_args__ = (
        Index("ix_deposits_counterparty_id", "counterparty_id"),
        Index("ix_deposits_source_order_id", "source_order_id"),
        Index("ix_deposits_pool_id", "pool_id"),
        CheckConstraint(
            f"status IN {DepositStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="deposit_status_valid",
        ),
        CheckConstraint(
            "paid_amount >= 0 AND returned_amount >= 0 AND lost_amount >= 0",
            name="amount_nonneg",
        ),
        CheckConstraint(
            "returned_amount + lost_amount <= paid_amount",
            name="released_amount_within_paid",
        ),
        CheckConstraint(
            f"ledger_type IN {CashflowLedgerType.values()!r}".replace("[", "(").replace("]", ")"),
            name="deposit_ledger_type_valid",
        ),
        CheckConstraint(
            "ledger_type <> 'STUDIO' OR source_order_id IS NULL",
            name="studio_deposit_no_order",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pool_id: Mapped[int] = mapped_column(
        ForeignKey("pools.id", ondelete="RESTRICT"), nullable=False
    )
    # 押金所属顶层账簿：BUSINESS 业务押金（挂合作方/平台/房租）或 STUDIO 工作室运营押金。
    # 决定占用/释放/损失/取消四条派生的 Cashflow.ledger_type，押金不进损益的口径不变。
    ledger_type: Mapped[str] = mapped_column(
        String(16), nullable=False,
        default=CashflowLedgerType.BUSINESS.value,
        server_default=CashflowLedgerType.BUSINESS.value,
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
    # FUNDDEPOSIT/FUNDRELEASE/FUNDLOSS/FUNDCANCEL 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class RebateRecord(Base, AuditMixin):
    """返点记录：新数据 source_order 必填，编号为订单从属号（REB-01）。"""

    __tablename__ = "rebate_records"
    __table_args__ = (
        CheckConstraint(
            f"rebate_type IN {RebateType.values()!r}".replace("[", "(").replace("]", ")"),
            name="rebate_type_valid",
        ),
        UniqueConstraint("rebate_no", name="uq_rebate_records_no"),
        Index("ix_rebate_records_source_order", "source_order_id"),
        CheckConstraint(
            "amount >= 0",
            name="amount_nonneg",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rebate_no: Mapped[str] = mapped_column(String(32), nullable=False)
    source_order_id: Mapped[int] = mapped_column(
        ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    rebate_type: Mapped[str] = mapped_column(
        String(16), nullable=False
    )
    channel: Mapped[str | None] = mapped_column(String(64), nullable=True)
    amount: Mapped[object] = mapped_column(Amount, nullable=False, default=0)
    # BAS-06-04 规则快照：创建时固化当时生效的规则版本与参数。
    collected_on: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 返点业务操作人：可多选；created_by 仍保留为审计操作者。
    operator_user_ids: Mapped[list[int] | None] = mapped_column(JSON, nullable=True)
    # REBATE/REBATEVOID 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)

# 返点分次结算模型 `RebateSettlement`（rebate_settlements 表）已于 2026-11-05 下线：
# 返点登记即完成收入确认，金额唯一取 rebate_records.amount，不再有分次到账、
# 手续费与冲销子记录。已有库（含生产）中的历史表保留、不 drop，避免破坏历史数据。
