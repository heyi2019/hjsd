"""从新版主订单列解析历史业务金额；预检与执行使用同一套规则。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from app.core.errors import Validation
from app.core.money import to_money
from app.settings.field_definitions.classification import classification_for_order_type

PRICE_COLUMNS = frozenset({"回收价", "提号价"})
FINANCE_COLUMNS = frozenset({
    "入库时间", "回收价", "提号价", "售卖时间", "售卖操作人", "售出金额", "代挂利润", "订单状态", "库存状态",
})


@dataclass(frozen=True)
class HistoricalFinance:
    buy_amount: Decimal | None
    buy_on: date | None
    sale_amount: Decimal | None
    sale_on: date | None
    profit: Decimal | None
    sale_at: datetime | None


def _money(record: dict[str, str], label: str) -> Decimal | None:
    raw = record.get(label, "").strip()
    if not raw:
        return None
    try:
        amount = to_money(raw, field=label)
        if abs(amount) >= Decimal("10000000000000000"):
            raise ValueError("金额超过系统范围")
        return amount
    except (ValueError, InvalidOperation) as exc:
        raise Validation(f"{label}不是有效金额") from exc


def _date(record: dict[str, str], label: str) -> date | None:
    raw = record.get(label, "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw) if len(raw) == 10 else datetime.fromisoformat(raw).date()
    except ValueError as exc:
        raise Validation(f"{label}格式无效") from exc


def historical_finance(record: dict[str, str], order_type: str) -> HistoricalFinance | None:
    """仅识别新版回收价／提号价列，不从旧成本汇总自动生成流水。"""
    if not PRICE_COLUMNS.intersection(record):
        return None
    mode = record.get("业务模式", "").strip()
    classification = classification_for_order_type(order_type)
    mode_values = {"自营": "SELF", "分销": "DISTRIBUTION", "SELF": "SELF", "DISTRIBUTION": "DISTRIBUTION"}
    if mode and (classification is None or mode_values.get(mode) != classification["business_mode"]):
        raise Validation("业务模式与业务类型不一致")
    if order_type in {"HS", "TH"} and record.get("代挂利润", "").strip():
        raise Validation("回收和提号订单不填写代挂利润")
    finance_columns = FINANCE_COLUMNS if order_type == "DG" else FINANCE_COLUMNS - {"代挂利润"}
    if not any(record.get(key, "").strip() for key in finance_columns):
        return None
    recovery = _money(record, "回收价")
    pickup = _money(record, "提号价")
    sale = _money(record, "售出金额")
    profit = _money(record, "代挂利润") if order_type == "DG" else None
    buy_on = _date(record, "入库时间")
    raw_sale_at = record.get("售卖时间", "").strip()
    try:
        sale_at = datetime.fromisoformat(raw_sale_at) if raw_sale_at else None
    except ValueError as exc:
        raise Validation("售卖时间格式无效") from exc
    if sale_at is not None and sale_at.tzinfo is not None:
        raise Validation("售卖时间不支持时区")
    sale_on = sale_at.date() if sale_at else None
    if any(value is not None and value < 0 for value in (recovery, pickup, sale)):
        raise Validation("回收价、提号价和售出金额不能为负数")
    if order_type == "HS":
        if recovery is None or pickup not in (None, 0):
            raise Validation("回收订单须填写回收价，提号价须为空或 0")
        buy = recovery
    elif order_type == "TH":
        if pickup is None or recovery not in (None, 0):
            raise Validation("提号订单须填写提号价，回收价须为空或 0")
        buy = pickup
    elif order_type == "DG":
        if recovery not in (None, 0) or pickup not in (None, 0):
            raise Validation("代挂订单的回收价和提号价须为空或 0")
        buy = None
    else:
        raise Validation("无法识别订单类型")
    if buy is not None and buy_on is None:
        raise Validation("生成入库支出须填写入库时间")
    if sale is not None and sale <= 0:
        raise Validation("售出金额必须大于 0")
    if (sale is None) != (sale_on is None):
        raise Validation("售出金额和售卖时间须同时填写")
    if sale_on and buy_on and sale_on < buy_on:
        raise Validation("售卖时间不能早于入库时间")
    if profit is not None and sale is None:
        raise Validation("登记代挂利润须填写售出金额和售卖时间")
    if order_type == "DG" and sale is not None and (profit is None or profit < 0):
        raise Validation("代挂售出须填写不小于 0 的代挂利润")
    status = record.get("订单状态", "").strip()
    status_sold = {"已完成": True, "COMPLETED": True, "进行中": False, "ACTIVE": False}
    if status and (status not in status_sold or status_sold[status] != (sale is not None)):
        raise Validation("订单状态与售出信息不一致或不支持导入")
    stock_status = record.get("库存状态", "").strip()
    stock_sold = {"已售": True, "SOLD": True, "出库": True, "OUT_OF_STOCK": True,
                  "在库": False, "待售": False, "WAITING": False, "IN_STOCK": False}
    if stock_status and (stock_status not in stock_sold or stock_sold[stock_status] != (sale is not None)):
        raise Validation("库存状态与售出信息不一致或不支持导入")
    return HistoricalFinance(buy, buy_on, sale, sale_on, profit, sale_at)
