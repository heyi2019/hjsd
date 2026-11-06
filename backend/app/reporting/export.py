"""reporting.export：报表统一导出（JSON / CSV）与财务维度汇总。
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date
from typing import Any
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.foundation import Pool
from sqlalchemy import (
    case,
    func,
    select,
)
from sqlalchemy.orm import Session
from app.domain.enums import (
    CashflowStatus,
    Direction,
)
from app.domain.trade import Cashflow

from ._shared import (
    REPORT_NAMES,
    _money,
    _sum_report_field,
    _validate_date_range,
    _visible_pool_ids,
)

from .funds import daily_funds_report
from .profit import order_profit_detail
from .r1_inventory import r1_inventory_health
from .r2_monthly_pnl import r2_monthly_pnl
from .r3_commission import r3_commission_reconciliation
from .r5_business_pnl import r5_business_pnl

def report_for_export(
    session: Session,
    report_name: str,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    on: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """统一执行可导出的报表，所有分支复用既有数据权限和口径。"""
    name = report_name.strip().lower()
    if name not in REPORT_NAMES:
        raise Validation(
            "不支持导出的报表",
            details={"report_name": report_name, "allowed": sorted(REPORT_NAMES)},
        )
    if name == "inventory-health":
        return r1_inventory_health(session, user=user)
    if name == "monthly-pnl":
        return r2_monthly_pnl(session, from_date=from_date, to_date=to_date, user=user)
    if name == "commission":
        return r3_commission_reconciliation(
            session, from_date=from_date, to_date=to_date, user=user
        )
    if name == "business-pnl":
        return r5_business_pnl(session, from_date=from_date, to_date=to_date, user=user)
    if name == "finance-dimensions":
        return finance_dimension_report(session, from_date=from_date, to_date=to_date, user=user)
    if name == "daily-funds":
        return daily_funds_report(session, on=on, user=user)
    return order_profit_detail(session, from_date=from_date, to_date=to_date, user=user)


def report_csv(
    report: dict[str, Any],
    *,
    columns: list[tuple[str, str, bool]] | None = None,
    value_labels: dict[str, dict[str, str]] | None = None,
    force_registered_keys: bool = False,
) -> str:
    """将报表 items 与 total 统一导出为 UTF-8 CSV，嵌套字段保留为 JSON。

    `columns` = 该报表对应列表作用域的**全部登记列** [(字段键, 中文表头, 是否可见)]：
    - 只导可见列，顺序按配置顺序，表头用中文（与界面列名一致）；
    - 「已登记但被隐藏」的列一律剔除 —— 界面看不到的列不该出现在导出的表里；
    - 明细行里**未登记**的键一律不导（order_id / pool_id / extra_values 这类内部字段
      此前会被当成新列追加出去，导出表因此很脏）；
    - 唯一例外：**合计行独有**的未登记键（如 total_amount），追加在末尾，避免合计丢失。
      注意必须传全量配置而非只传可见列，否则隐藏列会被误判成「未登记」；
    - 传 None 时退回「数据里出现什么键就导什么列」的旧行为。

    `force_registered_keys`：True 时可见登记列**无论行里是否出现过**都进表头
    （主列表导出空数据也要完整表头）；默认 False 保持报表旧行为（只出现在数据里的键才导）。

    `value_labels` = {列 key: {代码值: 中文}}，来自 lists.get_value_labels()：
    - 只翻译「字符串且命中字典」的单元格；金额 / 日期 / 未命中值原样输出；
    - row_type 是导出专用的机器标记（ITEM / TOTAL），不属于任何字典，保持英文，
      既有报表回归按它区分明细与合计；
    - 传 None 时所有值保留原样（旧行为）。
    """
    items = report.get("items") if isinstance(report.get("items"), list) else []
    total = report.get("total") if isinstance(report.get("total"), dict) else None
    rows: list[dict[str, Any]] = [
        {"row_type": "ITEM", **item} for item in items if isinstance(item, dict)
    ]
    if total is not None:
        rows.append({"row_type": "TOTAL", **total})
    keys: list[str] = ["row_type"]
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    if len(keys) == 1:
        keys.extend(["items", "total"])
    item_keys: set[str] = {
        key for item in items if isinstance(item, dict) for key in item
    }
    # 只认「合计行独有」的键：明细里也出现过的未登记字段（如 buy_amount）不算，
    # 否则界面没登记的明细字段会从合计行漏回导出表。
    total_only_keys: list[str] = [
        key for key in (total.keys() if total is not None else ()) if key not in item_keys
    ]

    if columns is None:
        fieldnames = list(keys)
        header = list(keys)
    else:
        labels = {key: label for key, label, _visible in columns}
        registered = {key for key, _label, _visible in columns}
        fieldnames = ["row_type"]
        for key, _label, visible in columns:
            if (
                visible
                and key != "row_type"
                and (force_registered_keys or key in keys)
                and key not in fieldnames
            ):
                fieldnames.append(key)
        # 只补合计行独有的字段：明细里的 order_id / extra_values 等内部字段不导
        for key in total_only_keys:
            if key not in fieldnames and key not in registered:
                fieldnames.append(key)
        header = ["row_type" if key == "row_type" else labels.get(key, key) for key in fieldnames]

    def normalize(value: Any) -> Any:
        if value is None:
            return ""
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False, default=str)
        return value

    def cell(key: str, value: Any) -> Any:
        mapping = value_labels.get(key) if value_labels else None
        if mapping and isinstance(value, str) and value in mapping:
            return mapping[value]
        return normalize(value)

    stream = io.StringIO(newline="")
    writer = csv.DictWriter(
        stream,
        fieldnames=fieldnames,
        extrasaction="ignore",
        lineterminator="\r\n",
    )
    # 表头手工写：fieldnames 是字段键（取值用），首行要中文
    writer.writerow(dict(zip(fieldnames, header)))
    for row in rows:
        writer.writerow({key: cell(key, row.get(key)) for key in fieldnames})
    return "\ufeff" + stream.getvalue()


def finance_dimension_report(
    session: Session,
    *,
    from_date: date | None = None,
    to_date: date | None = None,
    user: CurrentUser | None = None,
) -> dict[str, Any]:
    """按收支方向和资金池聚合已审核流水。"""
    _validate_date_range(from_date, to_date)
    stmt = (
        select(
            Pool.id.label("pool_id"),
            Pool.code.label("pool_code"),
            Pool.name.label("pool_name"),
            Cashflow.direction,
            case(
                (Cashflow.order_id.is_not(None), "BUSINESS"),
                else_="STUDIO",
            ).label("scope"),
            func.count(Cashflow.id).label("flow_count"),
            func.sum(Cashflow.amount).label("amount"),
            func.sum(
                case(
                    (Cashflow.direction == Direction.IN.value, Cashflow.amount),
                    else_=-Cashflow.amount,
                )
            ).label("signed_amount"),
        )
        .join(Pool, Pool.id == Cashflow.pool_id)
        .where(Cashflow.status == CashflowStatus.APPROVED.value)
        .group_by(
            Pool.id, Pool.code, Pool.name,
            Cashflow.direction,
            Cashflow.order_id.is_not(None),
        )
        .order_by(Pool.code, Cashflow.direction)
    )
    if from_date is not None:
        stmt = stmt.where(Cashflow.occurred_on >= from_date)
    if to_date is not None:
        stmt = stmt.where(Cashflow.occurred_on <= to_date)
    visible_pool_ids = _visible_pool_ids(user)
    if visible_pool_ids is not None:
        stmt = stmt.where(Cashflow.pool_id.in_(visible_pool_ids))
    rows = session.execute(stmt).mappings().all()
    items = [
        {
            "pool_id": row["pool_id"],
            "pool_code": row["pool_code"],
            "pool_name": row["pool_name"],
            "direction": row["direction"],
            "scope": row["scope"],
            "flow_count": int(row["flow_count"] or 0),
            "amount": _money(row["amount"]),
            "signed_amount": _money(row["signed_amount"]),
        }
        for row in rows
    ]
    return {
        "from_date": from_date.isoformat() if from_date else None,
        "to_date": to_date.isoformat() if to_date else None,
        "items": items,
        "total_amount": _sum_report_field(items, "amount"),
        "total_signed_amount": _sum_report_field(items, "signed_amount"),
    }
