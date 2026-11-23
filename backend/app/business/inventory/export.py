"""库存台账导出：筛选、明细汇总与 CSV 拼装全部由后端负责。"""
from __future__ import annotations

import csv
import io
import json
from collections.abc import Sequence
from typing import Any

from app.core.security import CurrentUser
from app.core.report_csv import spreadsheet_csv_cell
from app.business.inventory.collaboration import load_order_execution, load_order_execution_batch
from app.business.inventory.schemas import AccountOut
from app.settings.lists import service as list_columns_service


INVENTORY_EXPORT_HEADERS = (
    "订单号", "业务", "类型", "游戏/产品类型", "营地账号", "库存编号", "成本", "库存状态", "在手时间",
    "建档操作人", "登记时间", "出售时间", "下架时间", "寄售时间", "寄售平台",
    "渠道 / 区服", "绑定手机号", "有无二次", "账号描述", "账号图片", "备注", "执行明细", "资金明细",
    "支出笔数", "收入笔数", "总支出", "总收入",
)

BUSINESS_MODE_LABEL = {"SELF": "自营", "DISTRIBUTION": "分销"}
INVENTORY_TYPE_LABEL = {"RECOVERY": "回收", "PICKUP": "提号", "CONSIGNMENT": "代挂"}
INVENTORY_STATUS_LABEL = {"IN_STOCK": "在库", "OUT_OF_STOCK": "出库"}


def _minute(value: Any) -> str:
    if value is None:
        return "-"
    text = str(value).replace("T", " ")
    return text[:16] if len(text) >= 16 else f"{text[:10]} 00:00"


def _detail_text(detail: Any, source_order_id: int | None) -> dict[str, Any]:
    orders = detail.orders if detail is not None else []
    detail_view = detail.detail_view if detail is not None else None
    finance_rows = detail_view.finance_rows if detail_view is not None else []
    expense_rows = [row for row in finance_rows if row.direction == "支出"]
    income_rows = [row for row in finance_rows if row.direction == "收入"]
    event_by_id = {
        event.id: (event, order)
        for order in orders
        for event in order.events
    }
    source_order = next((order for order in orders if order.order_id == source_order_id), None)
    operations = detail_view.operation_rows if detail_view is not None else []
    consignment = next((row for row in operations if row.key == "consignment"), None)

    execution = "；".join(
        " / ".join((
            f"{event_by_id[row.event_id][0].event_no} · {row.action}" if row.event_id in event_by_id else row.action,
            _minute(row.occurred_at),
            str(row.amount) if row.amount is not None else "-",
            row.note,
            row.operator,
        ))
        for row in (detail_view.execution_rows if detail_view is not None else [])
    )
    finance = "；".join(
        " / ".join((
            row.type,
            event_by_id[row.event_id][1].order_no if row.event_id in event_by_id else "",
            event_by_id[row.event_id][0].event_no if row.event_id in event_by_id else row.key,
            row.direction,
            str(row.amount),
            _minute(row.occurred_at),
            row.pool_name,
        ))
        for row in finance_rows
    )
    return {
        "order_no": source_order.order_no if source_order is not None else "",
        "registration_at": _minute(source_order.created_at if source_order is not None else None),
        "sold_at": _minute(detail_view.lifecycle.sold_at if detail_view is not None else None),
        "removed_at": _minute(detail_view.lifecycle.removed_at if detail_view is not None else None),
        "consignment_at": _minute(consignment.occurred_at if consignment is not None else None),
        "consignment_platforms": consignment.content if consignment is not None else "-",
        "execution": execution,
        "finance": finance,
        "expense_count": len(expense_rows) if detail is not None else "不可用",
        "income_count": len(income_rows) if detail is not None else "不可用",
        "total_expense": str(detail.finance_summary.total_expense) if detail is not None else "不可用",
        "total_income": str(detail.finance_summary.total_income) if detail is not None else "不可用",
    }


def _row(account: AccountOut, detail_text: dict[str, Any]) -> list[Any]:
    return [
        detail_text["order_no"] or account.source_order_no or "",
        BUSINESS_MODE_LABEL.get(account.business_mode or "", account.business_mode or ""),
        INVENTORY_TYPE_LABEL.get(account.inventory_type or "", account.inventory_type or ""),
        account.game_type or "",
        account.camp_account or "",
        account.stock_no or "",
        account.cost_amount,
        INVENTORY_STATUS_LABEL.get(account.inventory_status, account.inventory_status),
        "" if account.inventory_age_days is None else f"{account.inventory_age_days}天",
        account.created_by,
        detail_text["registration_at"],
        detail_text["sold_at"],
        detail_text["removed_at"],
        detail_text["consignment_at"],
        detail_text["consignment_platforms"],
        account.channel_region or "",
        account.bound_phone or "",
        "" if account.has_secondary is None else ("有" if account.has_secondary else "无"),
        account.account_description or "",
        f"{len(account.account_images)}张" if account.account_images else "",
        account.note or "",
        detail_text["execution"],
        detail_text["finance"],
        detail_text["expense_count"],
        detail_text["income_count"],
        detail_text["total_expense"],
        detail_text["total_income"],
    ]


def build_inventory_ledger_csv(
    pairs: Sequence[tuple[Any, Any]],
    accounts: Sequence[AccountOut],
    *,
    db: Any,
    user: CurrentUser,
) -> tuple[str, int]:
    if len(pairs) != len(accounts):
        raise ValueError("库存与账号数量不匹配")
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow(INVENTORY_EXPORT_HEADERS)
    failed_details = 0
    for start in range(0, len(pairs), 500):
        batch = pairs[start:start + 500]
        try:
            with db.begin_nested():
                details = load_order_execution_batch(db, [order.id for _, order in batch], user)
                if len(details) != len(batch):
                    raise ValueError("订单详情数量不匹配")
        except Exception:
            details = []
            for _, order in batch:
                try:
                    with db.begin_nested():
                        detail = load_order_execution(db, order.id, user)
                    details.append(detail)
                except Exception:
                    details.append(None)
        for (_, order), account_out, detail in zip(batch, accounts[start:start + 500], details, strict=True):
            if detail is None:
                failed_details += 1
            writer.writerow([spreadsheet_csv_cell(value) for value in _row(account_out, _detail_text(detail, order.id))])
        del details, detail
    return f"\ufeff{output.getvalue()}", failed_details


def build_inventory_visible_csv(pairs: Sequence[tuple[Any, Any]], accounts: Sequence[AccountOut], *, db: Any) -> str:
    """按库存页面的列配置、顺序和行数据导出，不加载展开明细。"""
    if len(pairs) != len(accounts):
        raise ValueError("库存与账号数量不匹配")
    config = list_columns_service.get_config(db, "INVENTORY")
    columns = [column for column in config["columns"] if column["is_visible"] and column["key"] != "actions"]
    labels = list_columns_service.get_value_labels(db, "INVENTORY")
    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\r\n")
    writer.writerow([spreadsheet_csv_cell(column["label"]) for column in columns])
    order_types = {"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}
    for (_, order), account in zip(pairs, accounts, strict=True):
        inventory_type = account.inventory_type or order_types.get(order.order_type, "")
        status = "IN_STOCK" if account.status == "WAITING" else "OUT_OF_STOCK"
        values = {
            "stock_no": account.stock_no or "-",
            "order_no": order.order_no or "-",
            "inventory_entry_at": _minute(account.inventory_entry_at),
            "inventory_operator": account.inventory_operator or "-",
            "cost_amount": account.cost_amount,
            "account_game_type": account.game_type or "-",
            "account_game_account": account.game_account or "-",
            "business_mode": BUSINESS_MODE_LABEL.get(account.business_mode or "", account.business_mode or "-"),
            "inventory_type": INVENTORY_TYPE_LABEL.get(inventory_type, inventory_type or "-"),
            "inventory_age": "-" if account.inventory_age_days is None else f"{account.inventory_age_days}天",
            "status": labels.get("status", {}).get(status, INVENTORY_STATUS_LABEL.get(status, status)),
        }
        cells = []
        for column in columns:
            key = column["key"]
            if column.get("custom") and column.get("source_key"):
                value = (order.form_extra or {}).get(column["source_key"], values.get(column["source_key"]))
                mapping = column.get("value_labels") or {}
                if value is None or value == "" or value == []:
                    value = "-"
                elif isinstance(value, list):
                    value = "、".join(mapping.get(str(item), str(item)) for item in value)
                elif isinstance(value, bool):
                    value = "是" if value else "否"
                elif isinstance(value, dict):
                    value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                else:
                    value = mapping.get(str(value), str(value))
            else:
                value = values.get(key, "-")
            cells.append(spreadsheet_csv_cell(value))
        writer.writerow(cells)
    return f"\ufeff{output.getvalue()}"


__all__ = ["build_inventory_ledger_csv", "build_inventory_visible_csv"]
