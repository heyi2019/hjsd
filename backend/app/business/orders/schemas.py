"""orders.schemas：订单、事件、划转的请求/响应模型。

金额一律以字符串传输（如 `"1400.00"`），后端转 `Decimal`，禁止 float 参与计算（V15）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.settings.attachments.schemas import AttachmentOut



class CustomerRoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    customer_id: int = Field(gt=0)
    role: str = Field(min_length=1, max_length=64)


class CounterpartyRoleInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    counterparty_id: int = Field(gt=0)
    role: str = Field(min_length=1, max_length=64)


class CustomerDraftInput(BaseModel):
    """建单时内联输入的客户；后端在同一事务内复用或建档。"""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    display_name: str = Field(min_length=1, max_length=128)
    role: str = Field(min_length=1, max_length=64)
    contact_name: str | None = Field(default=None, max_length=64)
    phone: str | None = Field(default=None, max_length=64)
    wechat: str | None = Field(default=None, max_length=128)
    qq: str | None = Field(default=None, max_length=64)
    source: str | None = Field(default=None, max_length=128)
    note: str | None = None


class StockSaleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: Decimal = Field(ge=0)
    occurred_on: date
    pool_id: int | None = Field(default=None, gt=0)
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    note: str | None = None
    bound_phone: str | None = Field(default=None, max_length=64)
    bound_phone_owner: str | None = Field(default=None, max_length=128)
    sale_amount: Decimal | None = Field(default=None, ge=0)
    customer_input: CustomerDraftInput | None = None
    delivery_form_extra: dict[str, object] | None = None
    form_extra: dict[str, object] | None = None


class CounterpartyDraftInput(BaseModel):
    """建单时内联输入的供货方；后端在同一事务内复用或建档。"""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    display_name: str = Field(min_length=1, max_length=128)
    type: str = Field(min_length=1, max_length=32)
    role: str = Field(min_length=1, max_length=64)
    contact_name: str | None = Field(default=None, max_length=64)
    phone: str | None = Field(default=None, max_length=64)
    wechat: str | None = Field(default=None, max_length=128)
    qq: str | None = Field(default=None, max_length=64)
    note: str | None = None


class OrderAccountSnapshot(BaseModel):
    """订单中的产品快照：游戏账号是单一交易实体，游戏类型是产品类型。"""

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    game_account: str = Field(min_length=1, max_length=128)
    game_type: str | None = Field(default=None, max_length=64)
    game_password: str | None = Field(default=None, max_length=256)
    camp_account: str | None = Field(default=None, max_length=128)
    channel_region: str | None = Field(default=None, max_length=128)
    bound_phone: str | None = Field(default=None, max_length=64)
    bound_phone_owner: str | None = Field(default=None, max_length=128)
    has_secondary: bool | None = None
    secondary_images: list[str] | None = Field(default=None, max_length=3)
    wallet_realname: str | None = Field(default=None, max_length=16)
    wallet_realname_images: list[str] | None = Field(default=None, max_length=3)
    account_description: str | None = Field(default=None, max_length=2000)
    purchase_price: str | None = Field(default=None, max_length=32, description="账号号价（全款基础价格）")
    note: str | None = None
    # 账号／产品板块的自定义字段，随建单内联写入库存账号扩展资料。
    extra_values: dict[str, object] | None = None


class InitialBuyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount: Decimal = Field(ge=0)
    occurred_on: date
    pool_id: int | None = None
    portion: str = "PRINCIPAL"
    note: str | None = None


class InitialCostCreate(InitialBuyCreate):
    flow_category: str | None = None


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_type: str = Field(min_length=2, max_length=10, description="HS / TH / DG")
    trade_date: date
    account_snapshot: OrderAccountSnapshot | None = None
    account_id: int | None = None
    # 建单判重：同一游戏账号+游戏类型已有「已售出」记录时，后端返回
    # REPURCHASE_CONFIRM_REQUIRED；用户确认复购回流后带此标记重提即放行。
    # 已有「未售出」记录则无条件拒绝（INVENTORY_ACCOUNT_IN_STOCK），该标记不生效。
    confirm_repurchase: bool = Field(
        default=False, description="确认复购回流：仅对已售出的历史同账号生效"
    )
    owner_id: int | None = None
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    # 建单表单自定义字段值（由 OrderFormField 配置驱动），独立存储于订单 form_extra。
    form_extra: dict[str, object] | None = None
    customer_roles: list[CustomerRoleInput] = Field(default_factory=list)
    counterparty_roles: list[CounterpartyRoleInput] = Field(default_factory=list)
    customer_input: CustomerDraftInput | None = None
    counterparty_input: CounterpartyDraftInput | None = None
    initial_buy: InitialBuyCreate | None = None
    initial_costs: list[InitialCostCreate] = Field(default_factory=list)


class OrderUpdate(BaseModel):
    """订单编辑：未传字段保持原值，显式 null 代表清空可空字段。"""

    model_config = ConfigDict(extra="forbid")

    trade_date: date | None = None
    account_snapshot: OrderAccountSnapshot | None = None
    note: str | None = None
    extra_values: dict[str, object] | None = None
    # 表单字段配置体系（ORDEREDIT 作用域）：合并进订单 form_extra。
    form_extra: dict[str, object] | None = None


class OrderCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)
    # 表单字段配置体系（ORDERCANC 作用域）：合并进订单 form_extra。
    form_extra: dict[str, object] | None = None
    # 作用域可显式指定（如从库存发起的取消），缺省按取消单 ORDERCANC 校验。
    form_extra_scope: str | None = Field(default=None, min_length=2, max_length=16)


class InventoryOffsaleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)
    occurred_on: date
    unlisted_at: datetime
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    form_extra: dict[str, object] | None = None
    amount: Decimal | None = Field(default=None, ge=0)
    pool_id: int | None = Field(default=None, gt=0)
    portion: str = "PRINCIPAL"
    offset_event_id: int | None = Field(default=None, gt=0)


class OrderDeleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)


class OrderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    order_no: str
    order_type: str
    business_mode: str | None = None
    business_type: str | None = None
    value_added_service: str | None = None
    trade_date: date
    account_snapshot: dict | None = None
    option_label_snapshot: dict[str, str | dict[str, str]] | None = None
    account_id: int | None = None
    status: str
    owner_id: int | None = None
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    created_at: datetime


class OrderListOut(OrderOut):
    """工作台列表摘要：主订单之外只带列表需要的可读业务信息。"""

    account_game_type: str | None = None
    account_game_type_label: str | None = None
    stock_no: str | None = None
    account_game_account: str | None = None
    account_channel_region: str | None = None
    account_channel_region_label: str | None = None
    account_business_mode: str | None = None
    account_platform: str | None = None
    account_status: str | None = None
    party_name: str | None = None
    party_role: str | None = None
    party_source: str | None = None
    party_source_label: str | None = None
    party_created_by: str | None = None
    party_created_at: datetime | None = None
    inventory_entry_at: datetime | None = None
    inventory_operator: str | None = None
    sale_at: datetime | None = None
    sale_operator: str | None = None
    in_hand_time: str | None = None
    sale_amount: Decimal | None = None
    cost_amount: Decimal | None = None
    profit_base: Decimal | None = None
    last_event_type: str | None = None
    last_event_amount: Decimal | None = None
    last_event_on: date | None = None
    installment_principal: Decimal | None = None
    installment_paid: Decimal | None = None
    installment_periods: int | None = None
    installment_status: str | None = None


class OrderLedgerSummaryOut(BaseModel):
    """Filtered order-ledger totals aggregated by the backend."""

    model_config = ConfigDict(extra="forbid")

    total_count: int
    in_progress_count: int
    completed_count: int
    cancelled_count: int
    type_total: int
    status_counts: dict[str, int] = Field(default_factory=dict)
    type_counts: dict[str, int] = Field(default_factory=dict)
    game_types: list[str] = Field(default_factory=list)


class EventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_type: str
    finalize_sale_cancel: bool = False
    sale_mode: str | None = Field(
        default=None, description="SELL 的售出方式：FULL / INSTALLMENT"
    )
    operation_type: str | None = Field(
        default=None, description="OPERATE 的运营动作：IMAGE / DESCRIPTION / CONSIGNMENT / UNLIST"
    )
    rebate_type: str | None = Field(
        default=None, description="REBATE 的返点归属：BUY / SELL"
    )
    amount: Decimal = Field(default=Decimal("0"))
    occurred_on: date
    pool_id: int | None = Field(default=None, description="显式资金账户优先于默认资金账户")
    portion: str = "PRINCIPAL"
    delivery_direction: str | None = None
    offset_event_id: int | None = None
    reason: str | None = None
    operator_user_ids: list[int] | None = Field(default=None, min_length=1, max_length=30)
    note: str | None = None
    bound_phone: str | None = Field(default=None, max_length=64)
    bound_phone_owner: str | None = Field(default=None, max_length=128)
    form_extra_scope: str | None = Field(default=None, min_length=2, max_length=16)
    # 表单字段配置体系：操作类作用域自定义字段值，落 OrderEvent.form_extra。
    form_extra: dict[str, object] | None = None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_no: str
    order_id: int
    event_type: str
    sale_mode: str | None = None
    operation_type: str | None = None
    rebate_type: str | None = None
    amount: Decimal
    occurred_on: date
    pool_id: int | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_direction: str | None = None
    is_posted: bool
    posted_at: datetime | None = None
    reason: str | None = None
    operator_user_ids: list[int] | None = None
    note: str | None = None
    form_extra: dict[str, object] | None = None
    import_form_extra: str | None = None
    import_parent_no: str | None = None
    import_sequence: int | None = None
    import_pool_code: str | None = None
    import_offset_no: str | None = None
    import_is_posted: str | None = None
    import_source_type: str | None = None
    import_source_id: str | None = None
    created_at: datetime
    operator: str
    # 该事件还能被冲销多少：amount − Σ已冲销 CANCEL，夹底 0；CANCEL 自身恒 0。
    # 由后端下发，避免前端（订单页/库存页）各自再算一遍而口径漂移。
    cancellable_amount: Decimal = Decimal("0.00")


class OrderDetailOut(OrderOut):
    """订单详情：主字段 + 执行、资金、分期与审计摘要。"""

    form_extra: dict[str, object] | None = None
    events: list[EventOut] = Field(default_factory=list)
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
    category: str
    import_category: str | None = None
    direction: str
    amount: Decimal
    source_type: str
    source_id: str | None = None
    import_source_type: str | None = None
    import_source_id: str | None = None
    accounting_attribute: str | None = None
    pool_code: str | None = None
    note: str | None = None
    operator: str


class OrderRebateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rebate_no: str
    rebate_type: str
    channel: str | None = None
    amount: Decimal
    collected_on: date
    pool_code: str | None = None
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


class EventPostResult(BaseModel):
    event: EventOut
    cashflow_no: str | None = None


__all__ = [
    "EventCreate",
    "EventOut",
    "EventPostResult",
    "CounterpartyDraftInput",
    "CounterpartyRoleInput",
    "CustomerDraftInput",
    "CustomerRoleInput",
    "InitialBuyCreate",
    "OrderAccountSnapshot",
    "OrderCreate",
    "OrderCancelIn",
    "OrderDeleteIn",
    "OrderOut",
    "OrderDetailOut",
    "OrderListOut",
    "OrderUpdate",
]
