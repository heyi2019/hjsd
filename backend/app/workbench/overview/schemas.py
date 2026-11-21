"""工作台聚合查询响应模型。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class DashboardPeriodOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_date: date = Field(alias="from")
    to: date


class DashboardOrdersOut(BaseModel):
    total_count: int


class DashboardInventoryOut(BaseModel):
    account_count: int
    aging_count: int
    overdue_count: int


class DashboardInstallmentsOut(BaseModel):
    total_count: int
    overdue_count: int


class DashboardSummaryOut(BaseModel):
    period: DashboardPeriodOut | None
    orders: DashboardOrdersOut | None
    personal_orders: int | None
    personal_customers: int | None
    personal_earnings: Decimal | None
    inventory: DashboardInventoryOut | None
    installments: DashboardInstallmentsOut | None
