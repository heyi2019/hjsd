"""accounts.schemas：账号台账 API 的请求/响应模型（ACC-01）。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from app.core.schemas import PageOut, RequestModel

from ._common import INVENTORY_STATUSES, inventory_age_days as age_days, inventory_age_level as age_level
from .order_detail_view.schemas import OrderDetailViewOut

class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    stock_no: str | None = None
    source_order_id: int | None = None
    source_order_no: str | None = None
    game_account: str | None = None
    camp_account: str | None = None
    game_type: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    value_added_service: str | None = None
    game_password: str | None = None
    channel_region: str | None = None
    bound_phone: str | None = None
    has_secondary: bool | None = None
    secondary_images: list[str] | None = None
    wallet_realname: str | None = None
    wallet_realname_images: list[str] | None = None
    platform: str | None = None
    note: str | None = None
    account_description: str | None = None
    account_images: list[str] | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    status: str
    inventory_status: str
    inventory_entry_at: datetime
    cost_amount: Decimal
    buy_date: date | None = None
    created_by: str
    inventory_operator: str | None = None
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def inventory_age_days(self) -> int | None:
        """在库天数（自然日）：非在库为 None；与卡片指标同一口径，前端只展示。"""
        if self.inventory_status not in INVENTORY_STATUSES:
            return None
        return age_days(self.inventory_entry_at or self.buy_date or self.created_at)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def inventory_age_level(self) -> str | None:
        """库龄档位（NORMAL/WARNING/OVERDUE）：阈值由后端定义，前端只映射颜色。"""
        return age_level(self.inventory_age_days)


class AccountListOut(PageOut[AccountOut]):
    pass


class AccountProfileUpdate(RequestModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    game_account: str | None = Field(default=None, max_length=128)
    camp_account: str | None = Field(default=None, max_length=128)
    game_type: str | None = Field(default=None, max_length=64)
    game_password: str | None = Field(default=None, max_length=256)
    channel_region: str | None = Field(default=None, max_length=128)
    bound_phone: str | None = Field(default=None, max_length=64)
    has_secondary: bool | None = None
    secondary_images: list[str] | None = Field(default=None, max_length=3)
    wallet_realname: str | None = Field(default=None, max_length=16)
    wallet_realname_images: list[str] | None = Field(default=None, max_length=3)
    platform: str | None = Field(default=None, max_length=64)
    account_description: str | None = Field(default=None, max_length=2000)
    account_images: list[str] | None = Field(default=None, max_length=9)
    note: str | None = None
    extra_values: dict[str, object] | None = None
    # 表单字段配置体系（INVEDIT 作用域）：合并进账号 form_extra。
    form_extra: dict[str, object] | None = None


class AccountDeleteRequest(RequestModel):
    """删除的二次确认载荷：原因必填，只进审计日志，不落业务表。"""
    model_config = ConfigDict(str_strip_whitespace=True)

    reason: str = Field(min_length=1, max_length=200)

    @field_validator("reason")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        # str_strip_whitespace 已去首尾空格；这里再兜一次，防止纯空白绕过 min_length。
        if not value.strip():
            raise ValueError("删除原因不能为空")
        return value.strip()


class AccountInventoryOut(BaseModel):
    """库存中心在库台账接口的单行契约；与账号台账共享同一业务字段语义。"""

    model_config = ConfigDict(extra="forbid")

    account_id: int
    stock_no: str | None = None
    game_account: str | None = None
    business_mode: str | None = None
    inventory_type: str | None = None
    value_added_service: str | None = None
    platform: str | None = None
    status: str
    inventory_status: str
    inventory_entry_at: datetime
    cost_amount: Decimal
    account_description: str | None = None
    account_images: list[str] = Field(default_factory=list)
    extra_values: dict[str, object] = Field(default_factory=dict)


class InventoryResponseOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[AccountInventoryOut]
    count: int
    total_cost: Decimal


class InventoryStatsQuery(RequestModel):
    # 界面当前可见的账号集合；筛选留在前端做视图即时反馈，聚合与库龄口径归后端。
    account_ids: list[int] = Field(default_factory=list, max_length=5000)


class InventoryStatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_count: int
    occupied_cost: Decimal
    over_7d_count: int
    over_30d_count: int


class ExecutionCashflowOut(BaseModel):
    flow_no: str
    pool_name: str | None = None
    occurred_on: date
    occurred_at: datetime
    direction: str
    nature: str
    category: str
    amount: Decimal
    note: str | None = None
    operator: str


class ExecutionEventOut(BaseModel):
    id: int
    event_no: str
    event_type: str
    operation_type: str | None = None
    rebate_type: str | None = None
    amount: Decimal
    # 该事件仍可被冲销的余额 = amount − 已冲销合计（夹底 0）；CANCEL 自身恒为 0。
    # 口径与下单/冲销校验（`orders.events.post_event`）同源，前端不再自行相减。
    cancellable_amount: Decimal = Decimal("0")
    occurred_on: date
    occurred_at: datetime
    created_at: datetime
    posted_at: datetime | None = None
    pool_id: int | None = None
    offset_event_id: int | None = None
    portion: str
    delivery_mode: str | None = None
    delivery_direction: str | None = None
    is_posted: bool
    reason: str | None = None
    note: str | None = None
    form_extra: dict[str, object] = Field(default_factory=dict)
    cashflow: ExecutionCashflowOut | None = None
    operator: str
    operator_user_ids: list[int] | None = None
    operator_names: list[str] = Field(default_factory=list)


class ExecutionCounterpartyOut(BaseModel):
    id: int
    display_name: str
    role: str


class ExecutionCustomerOut(BaseModel):
    id: int
    display_name: str
    role: str


class ExecutionRebateOut(BaseModel):
    id: int
    rebate_no: str
    rebate_type: str
    channel: str | None = None
    rate: Decimal
    base_amount: Decimal
    status: str
    collected_on: date
    collected_at: datetime


class AccountExecutionOrderOut(BaseModel):
    order_id: int
    order_no: str
    order_type: str
    trade_date: date
    created_at: datetime
    status: str
    account_platform: str | None = None
    note: str | None = None
    extra_values: dict[str, object] = Field(default_factory=dict)
    extra_fields: list[dict[str, object]] = Field(default_factory=list)
    cashflows: list[ExecutionCashflowOut] = Field(default_factory=list)
    customers: list[ExecutionCustomerOut] = Field(default_factory=list)
    counterparties: list[ExecutionCounterpartyOut] = Field(default_factory=list)
    rebates: list[ExecutionRebateOut] = Field(default_factory=list)
    events: list[ExecutionEventOut]
    operator: str


class AccountAuditOut(BaseModel):
    id: int
    action: str
    entity_type: str
    entity_id: str
    actor: str
    reason: str | None = None
    occurred_at: datetime


class ExecutionFinanceSummaryOut(BaseModel):
    """账号维度的财务汇总：明细在前端拼装，合计一律由后端给。

    口径与本接口的 orders 完全一致（事件流水 + 订单独立流水 + 返点收入），
    另含分期坏账支出（损失计提，不占资金明细流水行）；前端不再对详情数据做第二遍累加。
    """

    cashflow_income: Decimal
    rebate_income: Decimal
    total_income: Decimal
    total_expense: Decimal
    net_amount: Decimal


class AccountExecutionDetailOut(BaseModel):
    account: AccountOut
    orders: list[AccountExecutionOrderOut]
    finance_summary: ExecutionFinanceSummaryOut
    detail_view: OrderDetailViewOut
    audit: list[AccountAuditOut] = Field(default_factory=list)

__all__ = [
    "AccountOut",
    "AccountListOut",
    "AccountProfileUpdate",
    "AccountDeleteRequest",
    "AccountInventoryOut",
    "InventoryResponseOut",
    "ExecutionCashflowOut",
    "ExecutionEventOut",
    "ExecutionCounterpartyOut",
    "ExecutionCustomerOut",
    "ExecutionRebateOut",
    "AccountExecutionOrderOut",
    "AccountAuditOut",
    "AccountExecutionDetailOut",
    "ExecutionFinanceSummaryOut",
    "OrderDetailViewOut",
]
