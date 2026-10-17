"""报表查询接口的响应契约。"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict


class ReportModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InventoryHealthItemOut(ReportModel):
    inventory_no: str
    game_account: str
    platform: str
    business: str | None = None
    status: str
    buy_amount: Decimal
    extra_cost: Decimal
    total_cost: Decimal
    holding_days: int | None = None
    expected_price: Decimal
    expected_profit: Decimal
    owner_id: int | None = None
    extra_values: dict[str, Any]


class InventoryHealthOut(ReportModel):
    generated_on: str
    items: list[InventoryHealthItemOut]
    total: int


class MonthlyPnlItemOut(ReportModel):
    month: str
    sales_income: Decimal
    account_direct_cost: Decimal
    operating_expense: Decimal
    rebate_income: Decimal
    operating_profit: Decimal


class MonthlyPnlTotalOut(ReportModel):
    sales_income: Decimal
    account_direct_cost: Decimal
    operating_expense: Decimal
    rebate_income: Decimal
    operating_profit: Decimal


class MonthlyPnlOut(ReportModel):
    items: list[MonthlyPnlItemOut]
    total: MonthlyPnlTotalOut


class CommissionOrderOut(ReportModel):
    user_id: int | None = None
    order_no: str
    order_id: int
    profit_base: Decimal
    rate: Decimal
    payable: Decimal
    paid: Decimal
    difference: Decimal


class CommissionGroupOut(ReportModel):
    user_id: int | None = None
    order_count: int
    profit_base: Decimal
    payable: Decimal
    paid: Decimal
    difference: Decimal
    orders: list[CommissionOrderOut]


class CommissionTotalOut(ReportModel):
    order_count: int
    payable: Decimal
    paid: Decimal
    difference: Decimal


class CommissionOut(ReportModel):
    items: list[CommissionOrderOut]
    groups: list[CommissionGroupOut]
    total: CommissionTotalOut


class BusinessPnlItemOut(ReportModel):
    order_type: str
    business_mode: str | None = None
    business_type: str | None = None
    value_added_service: str | None = None
    main_income: Decimal
    main_cost: Decimal
    main_profit: Decimal
    settled_rebate: Decimal
    uncollected_rebate: Decimal
    full_income: Decimal


class BusinessPnlTotalOut(ReportModel):
    main_income: Decimal
    main_cost: Decimal
    main_profit: Decimal
    settled_rebate: Decimal
    uncollected_rebate: Decimal
    full_income: Decimal


class BusinessPnlOut(ReportModel):
    items: list[BusinessPnlItemOut]
    total: BusinessPnlTotalOut


class FinanceDimensionItemOut(ReportModel):
    pool_id: int
    pool_code: str
    pool_name: str
    pool_account_id: int | None = None
    account_no: str | None = None
    account_name: str | None = None
    fund_nature: str
    accounting_attribute: str
    direction: str
    flow_count: int
    amount: Decimal
    signed_amount: Decimal


class FinanceDimensionOut(ReportModel):
    from_date: str | None = None
    to_date: str | None = None
    items: list[FinanceDimensionItemOut]
    total_amount: Decimal
    total_signed_amount: Decimal


class DailyFundsItemOut(ReportModel):
    pool_code: str
    pool_name: str
    opening: Decimal
    income: Decimal
    expense: Decimal
    transfer_in: Decimal
    transfer_out: Decimal
    deposit_paid: Decimal
    deposit_held: Decimal
    cash_balance: Decimal
    available: Decimal


class DailyFundsTotalOut(ReportModel):
    opening: Decimal
    income: Decimal
    expense: Decimal
    transfer_in: Decimal
    transfer_out: Decimal
    deposit_paid: Decimal
    deposit_held: Decimal
    cash_balance: Decimal
    available: Decimal


class DailyFundsOut(ReportModel):
    date: str
    items: list[DailyFundsItemOut]
    total: DailyFundsTotalOut


class OrderProfitItemOut(ReportModel):
    order_no: str
    order_id: int
    order_type: str
    trade_date: str
    status: str
    income: Decimal
    buy_amount: Decimal
    direct_cost: Decimal
    rebate: Decimal
    net_profit: Decimal
    extra_values: dict[str, Any]


class OrderProfitTotalOut(ReportModel):
    income: Decimal
    buy_amount: Decimal
    direct_cost: Decimal
    rebate: Decimal
    net_profit: Decimal


class OrderProfitOut(ReportModel):
    items: list[OrderProfitItemOut]
    total: OrderProfitTotalOut


__all__ = [
    "BusinessPnlOut",
    "FinanceDimensionOut",
    "CommissionOut",
    "DailyFundsOut",
    "InventoryHealthOut",
    "MonthlyPnlOut",
    "OrderProfitOut",
]
