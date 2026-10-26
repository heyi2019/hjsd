"""orders.schemas：订单、事件、划转的请求/响应模型。

金额一律以字符串传输（如 `"1400.00"`），后端转 `Decimal`，禁止 float 参与计算（V15）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.attachments.schemas import AttachmentOut


class CustomerRoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer_id: int = Field(gt=0)
    role: str = Field(min_length=1, max_length=64)


class CounterpartyRoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    counterparty_id: int = Field(gt=0)
    role: str = Field(min_length=1, max_length=64)


class OrderAccountSnapshot(BaseModel):
    """DFQ 建单时的账号文本快照，逾期回收时可转为库存账号。"""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    game_account: str = Field(min_length=1, max_length=128)
    game_type: str | None = Field(default=None, max_length=64)
    game_password: str | None = Field(default=None, max_length=256)
    channel_region: str | None = Field(default=None, max_length=128)
    bound_phone: str | None = Field(default=None, max_length=64)
    has_secondary: bool | None = None
    platform: str | None = Field(default=None, max_length=64)
    purchase_price: str | None = Field(default=None, max_length=32, description="账号号价（全款基础价格）")
    note: str | None = None


class InitialBuyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: Decimal = Field(ge=0)
    occurred_on: date
    pool_id: int | None = None
    portion: str = "PRINCIPAL"
    note: str | None = None


class InitialCostCreate(InitialBuyCreate):
    flow_category: str | None = None


class OrderInstallmentScheduleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period_no: int = Field(ge=1)
    due_on: date


class OrderInstallmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_type: str = Field(
        description="ADVANCE_PURCHASE / PICKUP_SALE / CONSIGNMENT_SALE"
    )
    principal: Decimal = Field(default=Decimal("0"), ge=0)
    down_payment: Decimal = Field(default=Decimal("0"), ge=0)
    service_fee: Decimal = Field(default=Decimal("0"), ge=0)
    periods: int = Field(gt=0)
    per_period_service_fee: Decimal = Field(default=Decimal("0"), ge=0)
    per_period: Decimal = Field(default=Decimal("0"), ge=0)
    adjust_final_period: bool = False
    first_due_on: date
    delivery_mode: str | None = None
    note: str | None = None
    schedule: list[OrderInstallmentScheduleCreate] | None = None


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_type: str = Field(min_length=2, max_length=10, description="HS / TH / DG / DFQ")
    trade_date: date
    account_snapshot: OrderAccountSnapshot | None = None
    account_id: int | None = None
    # HS / TH / DG 内联游戏账号字段，DFQ 建单仍走 account_snapshot。
    game_type: str | None = Field(default=None, max_length=64)
    game_account: str | None = Field(default=None, max_length=128)
    game_password: str | None = Field(default=None, max_length=256)
    channel_region: str | None = Field(default=None, max_length=128)
    bound_phone: str | None = Field(default=None, max_length=64)
    has_secondary: bool | None = None
    account_note: str | None = None
    owner_id: int | None = None
    capital_type: str | None = Field(default=None, description="默认取业务定义")
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    # 建单表单自定义字段值（由 OrderFormField 配置驱动），独立存储于订单 form_extra。
    form_extra: dict[str, object] | None = None
    customer_roles: list[CustomerRoleInput] = Field(default_factory=list)
    counterparty_roles: list[CounterpartyRoleInput] = Field(default_factory=list)
    initial_buy: InitialBuyCreate | None = None
    initial_costs: list[InitialCostCreate] = Field(default_factory=list)
    installment: OrderInstallmentCreate | None = None


class OrderUpdate(BaseModel):
    """订单编辑：未传字段保持原值，显式 null 代表清空可空字段。"""

    model_config = ConfigDict(extra="forbid")

    trade_date: date | None = None
    account_snapshot: OrderAccountSnapshot | None = None
    note: str | None = None
    extra_values: dict[str, object] | None = None


class OrderLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    related_order_id: int = Field(gt=0)
    relation_type: str = Field(min_length=1, max_length=16)
    split_ratio: Decimal | None = Field(default=None, gt=0, le=100)
    split_amount: Decimal | None = Field(default=None, gt=0)
    note: str | None = None


class OrderCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_no: str
    order_type: str
    capital_type: str
    business_mode: str | None = None
    business_type: str | None = None
    value_added_service: str | None = None
    trade_date: date
    account_snapshot: dict | None = None
    account_id: int | None = None
    status: str
    link_status: str
    owner_id: int | None = None
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    created_at: datetime


class OrderListOut(OrderOut):
    """工作台列表摘要：主订单之外只带列表需要的可读业务信息。"""

    account_game_type: str | None = None
    account_game_account: str | None = None
    account_channel_region: str | None = None
    account_business_mode: str | None = None
    account_platform: str | None = None
    account_status: str | None = None
    party_name: str | None = None
    party_role: str | None = None
    party_source: str | None = None
    party_created_by: str | None = None
    party_created_at: datetime | None = None
    event_total: Decimal | None = None
    last_event_type: str | None = None
    last_event_amount: Decimal | None = None
    last_event_on: date | None = None
    installment_principal: Decimal | None = None
    installment_paid: Decimal | None = None
    installment_periods: int | None = None
    installment_status: str | None = None


class EventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_type: str
    amount: Decimal = Field(default=Decimal("0"))
    occurred_on: date
    pool_id: int | None = Field(default=None, description="显式池优先于默认路由")
    portion: str = "PRINCIPAL"
    delivery_mode: str | None = None
    offset_event_id: int | None = None
    reason: str | None = None
    refund_responsibility: str | None = None
    flow_category: str | None = Field(
        default=None, description="COST 时可填 FEE / DESIGN / OTHER"
    )
    note: str | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_no: str
    order_id: int
    event_type: str
    amount: Decimal
    occurred_on: date
    pool_id: int | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    is_posted: bool
    posted_at: datetime | None = None
    reason: str | None = None
    refund_responsibility: str | None = None
    note: str | None = None
    created_at: datetime
    operator: str


class OrderDetailOut(OrderOut):
    """订单详情：主字段 + 执行、资金、分期与审计摘要。"""

    events: list[EventOut] = Field(default_factory=list)
    links: list["OrderLinkOut"] = Field(default_factory=list)
    cashflows: list["OrderCashflowOut"] = Field(default_factory=list)
    rebates: list["OrderRebateOut"] = Field(default_factory=list)
    installment: "OrderInstallmentOut | None" = None
    installment_schedule: list["OrderScheduleOut"] = Field(default_factory=list)
    audit: list["OrderAuditOut"] = Field(default_factory=list)
    attachments: list[AttachmentOut] = Field(default_factory=list)


class OrderCashflowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    flow_no: str
    pool_id: int
    occurred_on: date
    nature: str
    category: str
    direction: str
    amount: Decimal
    status: str
    order_event_id: int | None = None
    note: str | None = None
    operator: str


class OrderRebateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rebate_no: str
    rebate_type: str
    channel: str | None = None
    rate: Decimal
    base_amount: Decimal
    link_status: str
    status: str
    collected_on: date
    expected_on: date | None = None
    note: str | None = None
    created_at: datetime
    operator: str


class OrderInstallmentOut(BaseModel):
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
    status: str
    delivery_mode: str | None = None
    delivered_on: date | None = None
    first_due_on: date | None = None
    note: str | None = None


class OrderScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    installment_id: int
    period_no: int
    due_on: date
    due_amount: Decimal
    received_amount: Decimal
    waived_amount: Decimal
    status: str


class OrderAuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    action: str
    entity_type: str
    entity_id: str
    actor: str
    reason: str | None = None
    request_id: str | None = None
    occurred_at: datetime


class OrderLinkOut(BaseModel):
    id: int
    source_order_id: int
    source_order_no: str
    target_order_id: int
    target_order_no: str
    relation_type: str
    direction: str
    split_ratio: Decimal | None = None
    split_amount: Decimal | None = None
    note: str | None = None
    created_at: datetime


class EventPostResult(BaseModel):
    event: EventOut
    cashflow_no: str | None = None


class PoolBalanceOut(BaseModel):
    pool_id: int
    pool_code: str
    income: Decimal
    expense: Decimal
    transfer_in: Decimal
    transfer_out: Decimal
    cash_balance: Decimal
    deposit_held: Decimal
    available: Decimal


__all__ = [
    "EventCreate",
    "EventOut",
    "EventPostResult",
    "CounterpartyRoleInput",
    "CustomerRoleInput",
    "InitialBuyCreate",
    "OrderAccountSnapshot",
    "OrderCreate",
    "OrderCancelIn",
    "OrderInstallmentCreate",
    "OrderLinkCreate",
    "OrderInstallmentScheduleCreate",
    "OrderOut",
    "OrderDetailOut",
    "OrderListOut",
    "OrderLinkOut",
    "OrderUpdate",
    "OrderFormFieldOut",
    "OrderFormFieldCreate",
    "OrderFormFieldUpdate",
    "PoolBalanceOut",
]


class FieldOption(BaseModel):
    value: str
    label: str


class OrderFormFieldOut(BaseModel):
    """建单表单字段配置响应。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    order_type_code: str
    field_key: str
    label: str
    field_type: str
    options: list[FieldOption] | None = None
    required: bool
    is_active: bool
    sort_order: int
    locked: bool
    is_custom: bool
    note: str | None = None


class OrderFormFieldCreate(BaseModel):
    """新增建单表单字段（自定义字段）。核心字段由种子锁定，不可经此创建覆盖。"""

    model_config = ConfigDict(extra="forbid")

    order_type_code: str = Field(min_length=2, max_length=16)
    field_key: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=128)
    field_type: str = "TEXT"
    options: list[FieldOption] | None = None
    required: bool = False
    is_active: bool = True
    sort_order: int = 0
    is_custom: bool = True
    note: str | None = None


class OrderFormFieldUpdate(BaseModel):
    """编辑建单表单字段：label/类型/选项/必填/排序/停用均可改；field_key 与 code 固定。"""

    model_config = ConfigDict(extra="forbid")

    label: str | None = None
    field_type: str | None = None
    options: list[FieldOption] | None = None
    required: bool | None = None
    sort_order: int | None = None
    note: str | None = None

