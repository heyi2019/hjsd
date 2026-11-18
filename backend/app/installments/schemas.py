"""installments.schemas：分期合约与收款请求/响应模型。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.core.money import to_money
from app.core.schemas import RequestModel
from app.shared.installment_amounts import total_receivable


class ScheduleCreate(RequestModel):
    period_no: int = Field(ge=1)
    due_on: date
    service_fee_rate: Decimal = Decimal("0")


class InstallmentTotalsOut(BaseModel):
    """分期台合计：与列表同条件、服务端 Decimal 聚合，前端不再对当页求和。"""

    total_receivable: Decimal
    total_paid: Decimal
    total_remaining: Decimal
    total_count: int
    overdue_count: int


class OperationOperatorOut(BaseModel):
    """某个业务动作的操作人快照，供列表展开/详情编辑使用。"""

    model_config = ConfigDict(from_attributes=True)

    operation_key: str
    operator_user_ids: list[int]
    occurred_at: datetime


class OperationOperatorsUpdateIn(RequestModel):
    operator_user_ids: list[int] = Field(min_length=1, max_length=30)


class SaleInstallmentPlanIn(RequestModel):
    sale_amount: Decimal = Field(ge=0)
    down_payment: Decimal = Field(default=Decimal("0"), ge=0)
    service_fee: Decimal = Field(default=Decimal("0"), ge=0)
    periods: int = Field(gt=0)
    per_period: Decimal | None = Field(default=None, ge=0)


class SaleInstallmentPlanOut(BaseModel):
    principal: Decimal
    down_payment: Decimal
    service_fee: Decimal
    periods: int
    base_amount: Decimal
    total_schedule_amount: Decimal
    per_period: Decimal
    last_period: Decimal
    per_period_service_fee: Decimal
    per_period_matches: bool | None = None


class InstallmentCreate(RequestModel):
    order_id: int
    contract_type: str = Field(
        description="STOCK_SALE / PICKUP_SALE / CONSIGNMENT_SALE"
    )
    principal: Decimal = Decimal("0")
    down_payment: Decimal = Decimal("0")
    # 省略（null）时按 INSTALLMENT 规则的 service_fee_rate × 基数补算；传 0 视为「不收服务费」。
    service_fee: Decimal | None = None
    periods: int = Field(gt=0)
    per_period_service_fee: Decimal = Decimal("0")
    per_period: Decimal = Decimal("0")
    adjust_final_period: bool = False
    first_due_on: date
    delivery_mode: str | None = None
    note: str | None = None
    schedule: list[ScheduleCreate] | None = None
    extra_values: dict[str, Any] | None = None
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class ScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    installment_id: int
    period_no: int
    due_on: date
    service_fee_rate: Decimal
    due_amount: Decimal
    received_amount: Decimal
    waived_amount: Decimal
    status: str
    # 后端下发的期次可用动作（waive/extend）；前端只回显，不再按 status 判定
    available_actions: list[str] = Field(default_factory=list)


class DispositionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    installment_id: int
    account_id: int
    action: str
    occurred_on: date
    related_order_id: int | None = None
    note: str


class InstallmentOrderOut(BaseModel):
    """分期列表所需的订单事实，直接由后端从订单/库存/参与方表装配。"""

    id: int
    order_no: str
    order_type: str
    trade_date: date
    account_game_type: str | None = None
    account_game_account: str | None = None
    account_business_mode: str | None = None
    party_name: str | None = None
    bound_phone: str | None = None
    bound_phone_owner: str | None = None


class InstallmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    inst_no: str
    order_id: int
    contract_type: str
    principal: Decimal
    down_payment: Decimal
    service_fee: Decimal
    periods: int
    per_period_service_fee: Decimal
    per_period: Decimal
    paid_amount: Decimal
    waived_amount: Decimal
    bad_debt_amount: Decimal
    final_period_adjustment: Decimal = Decimal("0")
    status: str
    operator: str | None = None
    delivery_mode: str | None = None
    delivered_on: date | None = None
    first_due_on: date | None = None
    note: str | None = None
    extra_values: dict[str, Any] = Field(default_factory=dict)
    form_extra: dict[str, Any] | None = None
    order: InstallmentOrderOut
    schedules: list[ScheduleOut] = Field(default_factory=list)
    dispositions: list[DispositionOut] = Field(default_factory=list)
    operation_operators: list[OperationOperatorOut] = Field(default_factory=list)
    # 后端下发的合约级可用动作（pay/deliver/recover/cancel/settle_early/default/resale）；
    # 等价搬运自前端原状态判定，前端只回显，不再自行拼状态白名单
    available_actions: list[str] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_receivable(self) -> Decimal:
        """总应收（口径唯一来源，前端只读不再自行计算）。

        与 shared.installment_amounts 同源（直接调用，不再复制公式）：
        首付 + 每期 × 期数 + 末期调整 − 减免。
        """
        return total_receivable(self)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def remaining_receivable(self) -> Decimal:
        """剩余应收 = 总应收 − 已收 − 坏账，且**不小于 0**。

        口径唯一来源在后端：前端原先自己相减，先收后减免时会出现负的「剩余」。
        已收 + 坏账超过总应收（减免把应收降到已收之下）时按 0 计，不显示负数。
        """
        remaining = (
            self.total_receivable
            - to_money(self.paid_amount)
            - to_money(self.bad_debt_amount or 0)
        )
        return remaining if remaining > 0 else Decimal("0.00")


class PaymentIn(RequestModel):
    amount: Decimal
    paid_on: date
    period_no: int | None = None
    pool_id: int | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class EarlySettlementIn(RequestModel):
    paid_on: date
    pool_id: int | None = None
    note: str | None = None
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class DefaultIn(RequestModel):
    reason: str = Field(min_length=1)
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class CancelIn(RequestModel):
    cancelled_on: date
    reason: str = Field(min_length=1)
    # 表单字段配置体系（INVCANCEL 作用域）：自定义字段值落分期 form_extra。
    form_extra: dict[str, object] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class DispositionIn(RequestModel):
    occurred_on: date
    note: str = Field(min_length=1)
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class ResaleIn(DispositionIn):
    resale_order_id: int


class ScheduleWaiveIn(RequestModel):
    amount: Decimal = Field(gt=0)
    waived_on: date
    reason: str = Field(min_length=1)
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class ScheduleExtendIn(RequestModel):
    new_due_on: date
    reason: str = Field(min_length=1)
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class DeliverIn(RequestModel):
    delivery_mode: str
    delivered_on: date
    note: str = Field(min_length=1, description="换绑凭证说明")
    bound_phone: str | None = Field(default=None, max_length=64)
    bound_phone_owner: str | None = Field(default=None, max_length=128)
    form_extra: dict[str, Any] | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)


class PaymentResult(BaseModel):
    installment: InstallmentOut
    schedule: ScheduleOut


class InstallmentCancelResult(BaseModel):
    installment: InstallmentOut
    order_status: str
    account_status: str | None = None
    refund_amount: Decimal
    reversed_amount: Decimal
    cancel_event_ids: list[int] = Field(default_factory=list)


class MarkOverdueOut(BaseModel):
    marked: int


__all__ = [
    "DeliverIn",
    "CancelIn",
    "DefaultIn",
    "DispositionIn",
    "DispositionOut",
    "EarlySettlementIn",
    "InstallmentCreate",
    "InstallmentOrderOut",
    "InstallmentOut",
    "InstallmentCancelResult",
    "OperationOperatorOut",
    "OperationOperatorsUpdateIn",
    "MarkOverdueOut",
    "PaymentIn",
    "PaymentResult",
    "ScheduleExtendIn",
    "ScheduleWaiveIn",
    "ScheduleCreate",
    "ScheduleOut",
    "ResaleIn",
]
