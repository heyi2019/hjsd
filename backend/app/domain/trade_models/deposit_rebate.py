"""押金与返点（DG-01、REB-01）。"""

from __future__ import annotations

from app.core.database import Base
from app.core.money import Amount
from app.domain.base import AuditMixin
from app.domain.enums import (
    DepositStatus,
    LinkStatus,
    RebateStatus,
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
    # FUNDDEPOSIT/FUNDRELEASE/FUNDLOSS/FUNDCANCEL 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class RebateRecord(Base, AuditMixin):
    """返点记录：新数据 source_order 必填，编号为订单从属号（REB-01）。"""

    __tablename__ = "rebate_records"
    __table_args__ = (
        Index("ix_rebate_records_policy_version_id", "policy_version_id"),
        CheckConstraint(
            f"status IN {RebateStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="rebate_status_valid",
        ),
        CheckConstraint(
            f"rebate_type IN {RebateType.values()!r}".replace("[", "(").replace("]", ")"),
            name="rebate_type_valid",
        ),
        UniqueConstraint("rebate_no", name="uq_rebate_records_no"),
        Index("ix_rebate_records_source_order", "source_order_id"),
        CheckConstraint(
            "rate >= 0 AND base_amount >= 0",
            name="amount_nonneg",
        ),
        CheckConstraint("rate <= 100", name="rate_max"),
        CheckConstraint(
            f"link_status IN {LinkStatus.values()!r}".replace("[", "(").replace("]", ")"),
            name="rebate_link_status_valid",
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
    # 返点业务操作人：可多选；created_by 仍保留为审计操作者。
    operator_user_ids: Mapped[list[int] | None] = mapped_column(JSON, nullable=True)
    # REBATE/REBATEVOID 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class RebateSettlement(Base, AuditMixin):
    """返点分次结算：净额 = 毛额 − 手续费，冲销通过反向子记录留痕。"""

    __tablename__ = "rebate_settlements"
    __table_args__ = (
        Index("ix_rebate_settlements_rebate_record_id", "rebate_record_id"),
        Index("ix_rebate_settlements_fee_cashflow_id", "fee_cashflow_id"),
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
        CheckConstraint(
            "net_amount = gross_amount - platform_fee",
            name="net_amount_matches_breakdown",
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
    fee_cashflow_id: Mapped[int | None] = mapped_column(
        ForeignKey("cashflow.id", ondelete="SET NULL"), nullable=True
    )
    reversal_of_id: Mapped[int | None] = mapped_column(
        ForeignKey("rebate_settlements.id", ondelete="RESTRICT"), nullable=True
    )
    # REBSETTLE/REBREVERSE 作用域自定义字段值。
    form_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
