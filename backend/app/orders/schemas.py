"""orders.schemas：订单、事件、划转的请求/响应模型。

金额一律以字符串传输（如 `"1400.00"`），后端转 `Decimal`，禁止 float 参与计算（V15）。
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.attachments.schemas import AttachmentOut

FlowDirection = Literal["BASE", "IN", "OUT"]


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
    platform: str | None = Field(default=None, max_length=64)
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


class OrderInstallmentScheduleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    period_no: int = Field(ge=1)
    due_on: date


class OrderInstallmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_type: str = Field(
        description="STOCK_SALE / PICKUP_SALE / CONSIGNMENT_SALE"
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
    delivery_direction: str | None = Field(
        default=None, description="DELIVER 的交付方向：BUY / SELL"
    )
    note: str | None = None
    schedule: list[OrderInstallmentScheduleCreate] | None = None


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
    capital_type: str | None = Field(default=None, description="默认取业务定义")
    note: str | None = None
    # 佣金口径（BAS：仅 DG 代挂单可用；两者必须同时填写或同时留空）
    commission_mode: str | None = Field(
        default=None, max_length=32, description="DEDUCT_FROM_SETTLEMENT / SEPARATE_PAYMENT"
    )
    commission_payer: str | None = Field(
        default=None, max_length=16, description="BUYER / CONSIGNOR / PLATFORM"
    )
    extra_values: dict[str, object] = Field(default_factory=dict)
    # 建单表单自定义字段值（由 OrderFormField 配置驱动），独立存储于订单 form_extra。
    form_extra: dict[str, object] | None = None
    # 库存售出/寄售等从库存发起的操作表单，值仍落订单，但按操作作用域校验。
    form_extra_scope: str | None = Field(default=None, min_length=2, max_length=16)
    customer_roles: list[CustomerRoleInput] = Field(default_factory=list)
    counterparty_roles: list[CounterpartyRoleInput] = Field(default_factory=list)
    customer_input: CustomerDraftInput | None = None
    counterparty_input: CounterpartyDraftInput | None = None
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
    # 表单字段配置体系（ORDEREDIT 作用域）：合并进订单 form_extra。
    form_extra: dict[str, object] | None = None


class OrderLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    related_order_id: int = Field(gt=0)
    relation_type: str = Field(min_length=1, max_length=16)
    split_ratio: Decimal | None = Field(default=None, gt=0, le=100)
    split_amount: Decimal | None = Field(default=None, gt=0)
    note: str | None = None
    # 表单字段配置体系（ORDERLINK 作用域）：自定义字段值落 OrderLink.form_extra。
    form_extra: dict[str, object] | None = None


class OrderCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)
    # 表单字段配置体系（ORDERCANC 作用域）：合并进订单 form_extra。
    form_extra: dict[str, object] | None = None
    # 作用域可显式指定（如从库存发起的取消），缺省按取消单 ORDERCANC 校验。
    form_extra_scope: str | None = Field(default=None, min_length=2, max_length=16)


class OrderDeleteIn(BaseModel):
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
    commission_mode: str | None = None
    commission_payer: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    created_at: datetime


class OrderListOut(OrderOut):
    """工作台列表摘要：主订单之外只带列表需要的可读业务信息。"""

    account_game_type: str | None = None
    stock_no: str | None = None
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


class EventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_type: str
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
    pool_id: int | None = Field(default=None, description="显式池优先于默认路由")
    portion: str = "PRINCIPAL"
    delivery_mode: str | None = None
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
    delivery_mode: str | None = None
    delivery_direction: str | None = None
    is_posted: bool
    posted_at: datetime | None = None
    reason: str | None = None
    operator_user_ids: list[int] | None = None
    note: str | None = None
    form_extra: dict[str, object] | None = None
    created_at: datetime
    operator: str
    # 该事件还能被冲销多少：amount − Σ已冲销 CANCEL，夹底 0；CANCEL 自身恒 0。
    # 由后端下发，避免前端（订单页/库存页）各自再算一遍而口径漂移。
    cancellable_amount: Decimal = Decimal("0.00")


class OrderDetailOut(OrderOut):
    """订单详情：主字段 + 执行、资金、分期与审计摘要。"""

    form_extra: dict[str, object] | None = None
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
    form_extra: dict[str, object] | None = None
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


class PoolBalanceTotalsOut(BaseModel):
    """资金池余额汇总：服务端按 Decimal 聚合，前端只展示不再自己累加。"""

    cash_balance: Decimal
    # 可用余额 = 现金余额；押金占用已在 expense 扣过一次，不再二次减 deposit_held。
    available: Decimal
    deposit_held: Decimal  # 其中项：押金占用，仅展示不参与 available 计算
    # 自有权益口径：仅 ownership=OWNED 的池、按现金头寸计（押金占用已进 expense）。
    owned_cash_balance: Decimal


class PoolBalanceListOut(BaseModel):
    """批量余额：一次返回全部可见池的卡片与汇总，替代前端逐池 N+1。"""

    items: list[PoolBalanceOut]
    totals: PoolBalanceTotalsOut


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
    "RequiredWhen",
    "PoolBalanceOut",
]


class FieldOption(BaseModel):
    value: str
    label: str


class RequiredWhen(BaseModel):
    """条件必填条件：依赖同作用域内某个字段的取值。

    - op=eq：依赖字段值属于 values 任一 → 必填；
    - op=ne：依赖字段值不属于 values → 必填；
    - op=filled：依赖字段有值（非空字符串/非 null）→ 必填，此时 values 必须为空。
    """

    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1, max_length=64)
    op: str = Field(default="eq", pattern="^(eq|ne|filled)$")
    values: list[str] | None = None


class OrderFormFieldOut(BaseModel):
    """建单表单字段配置响应。"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    order_type_code: str
    field_key: str
    label: str
    field_type: str
    options: list[FieldOption] | None = None
    flow_direction: FlowDirection | None = None
    required: bool
    required_when: RequiredWhen | None = None
    is_active: bool
    sort_order: int
    locked: bool
    is_custom: bool
    section: str = "EXTRA"
    note: str | None = None


class FormScopeOut(BaseModel):
    """表单作用域（设置页「表单」下拉清单，来自 form_scopes 注册表）。"""

    code: str
    label: str
    group: str


class OrderFormFieldCreate(BaseModel):
    """新增建单表单字段（自定义字段）。核心字段由种子锁定，不可经此创建覆盖。"""

    model_config = ConfigDict(extra="forbid")

    order_type_code: str = Field(min_length=2, max_length=16)
    field_key: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=128)
    field_type: str = "TEXT"
    options: list[FieldOption] | None = None
    flow_direction: FlowDirection | None = None
    required: bool = False
    required_when: RequiredWhen | None = None
    is_active: bool = True
    sort_order: int = 0
    is_custom: bool = True
    section: str = Field(default="EXTRA", pattern="^[A-Z][A-Z0-9_]{0,31}$")
    note: str | None = None


class SectionLabelsSaveIn(BaseModel):
    """保存某业务类型的板块标题：order_type_code 须为已注册作用域，labels 为板块键→标题。"""

    model_config = ConfigDict(extra="forbid")

    order_type_code: str = Field(min_length=2, max_length=16)
    labels: dict[str, str]


class OrderFormFieldUpdate(BaseModel):
    """编辑建单表单字段：label/类型/选项/必填态（含条件必填）/排序/备注均可改；field_key 与 code 固定。

    required_when 语义：不传=保持不变；传 null=清除条件（回退纯选填）；传对象=设为条件必填。
    """

    model_config = ConfigDict(extra="forbid")

    label: str | None = None
    field_type: str | None = None
    options: list[FieldOption] | None = None
    flow_direction: FlowDirection | None = None
    required: bool | None = None
    required_when: RequiredWhen | None = None
    sort_order: int | None = None
    section: str | None = Field(default=None, pattern="^[A-Z][A-Z0-9_]{0,31}$")
    note: str | None = None


