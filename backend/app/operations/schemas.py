"""报表查询接口的响应契约。"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict


class ReportModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class MonthlyPnlItemOut(ReportModel):
    month: str
    sales_income: Decimal
    cost: Decimal
    operating_expense: Decimal
    rebate_income: Decimal
    operating_profit: Decimal


class MonthlyPnlTotalOut(ReportModel):
    sales_income: Decimal
    cost: Decimal
    operating_expense: Decimal
    rebate_income: Decimal
    operating_profit: Decimal


class MonthlyPnlOut(ReportModel):
    items: list[MonthlyPnlItemOut]
    total: MonthlyPnlTotalOut


class CommissionOrderOut(ReportModel):
    user_id: int | None = None
    user_name: str | None = None
    order_no: str
    order_id: int
    inventory_date: date | None = None
    outbound_date: date | None = None
    allocation_type: str | None = None
    profit_base: Decimal
    rate: Decimal


class CommissionOrderGroupOut(ReportModel):
    order_id: int
    order_no: str
    inventory_date: date | None = None
    outbound_date: date | None = None
    profit_base: Decimal
    orders: list[CommissionOrderOut]


class CommissionTotalOut(ReportModel):
    order_count: int
    profit_base: Decimal


class CommissionPersonOut(ReportModel):
    user_id: int
    user_name: str
    is_active: bool


class CommissionOut(ReportModel):
    order_groups: list[CommissionOrderGroupOut]
    people: list[CommissionPersonOut]
    total: CommissionTotalOut


class BusinessPnlItemOut(ReportModel):
    order_type: str
    business_mode: str | None = None
    business_type: str | None = None
    value_added_service: str | None = None
    main_income: Decimal
    cost: Decimal
    main_profit: Decimal


class BusinessPnlTotalOut(ReportModel):
    main_income: Decimal
    cost: Decimal
    main_profit: Decimal


class BusinessPnlOut(ReportModel):
    items: list[BusinessPnlItemOut]
    total: BusinessPnlTotalOut


class DataCenterOut(ReportModel):
    order_count: int
    active_order_count: int
    sold_cost: Decimal
    in_transit_cost: Decimal
    deposit_held: Decimal
    studio_cost: Decimal
    account_sale_profit: Decimal
    studio_other_income: Decimal
    profit: Decimal


class OrderProfitItemOut(ReportModel):
    order_no: str
    order_id: int
    order_type: str
    trade_date: str
    status: str
    income: Decimal
    cost: Decimal
    rebate: Decimal
    net_profit: Decimal
    extra_values: dict[str, Any]


class OrderProfitTotalOut(ReportModel):
    income: Decimal
    cost: Decimal
    rebate: Decimal
    net_profit: Decimal


class OrderProfitOut(ReportModel):
    items: list[OrderProfitItemOut]
    total: OrderProfitTotalOut


__all__ = [
    "BusinessPnlOut",
    "DataCenterOut",
    "CommissionOut",
    "MonthlyPnlOut",
    "OrderProfitOut",
]
