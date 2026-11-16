"""accounts.schemas：账号台账 API 的请求/响应模型（ACC-01）。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

from app.core.schemas import PageOut, RequestModel

from ._common import INVENTORY_STATUSES, inventory_age_days as age_days, inventory_age_level as age_level

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
        return age_days(self.inventory_entry_at)

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


class InventoryCostSummaryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_cost: Decimal


class InventoryStatsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_count: int
    occupied_cost: Decimal
    over_7d_count: int
    over_30d_count: int


class InventoryLedgerItemOut(BaseModel):
    account: AccountOut
    order: dict[str, object]


class InventoryLedgerOut(BaseModel):
    items: list[InventoryLedgerItemOut]
    total: int
    facet_total: int
    type_counts: dict[str, int]
    game_types: list[str]
    stats: InventoryStatsOut


__all__ = [
    "AccountOut",
    "AccountListOut",
    "AccountProfileUpdate",
    "AccountDeleteRequest",
    "AccountInventoryOut",
    "InventoryResponseOut",
    "InventoryCostSummaryOut",
    "InventoryLedgerItemOut",
    "InventoryLedgerOut",
]
