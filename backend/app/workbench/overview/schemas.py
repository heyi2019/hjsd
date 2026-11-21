"""工作台聚合查询响应模型。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field


class WorkbenchPeriodOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    from_date: date = Field(alias="from")
    to: date


class WorkbenchOrdersOut(BaseModel):
    total_count: int


class WorkbenchInventoryOut(BaseModel):
    account_count: int
    aging_count: int
    overdue_count: int


class WorkbenchInstallmentsOut(BaseModel):
    total_count: int
    overdue_count: int


class WorkbenchSummaryOut(BaseModel):
    period: WorkbenchPeriodOut | None
    orders: WorkbenchOrdersOut | None
    personal_orders: int | None
    personal_customers: int | None
    personal_earnings: Decimal | None
    inventory: WorkbenchInventoryOut | None
    installments: WorkbenchInstallmentsOut | None
