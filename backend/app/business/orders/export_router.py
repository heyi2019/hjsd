"""订单台账 CSV / XLSX 导出接口。"""
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.enums import AuditAction
from app.settings.lists import service as list_columns_service
from app.settings.lists.export import (
    UI_ONLY_KEYS,
    build_list_csv,
    inject_custom_columns,
    merge_static_value_labels,
)
from app.settings.lists.file_response import CSV_MEDIA_TYPE, XLSX_MEDIA_TYPE, file_response
from app.settings.lists.xlsx import new_workbook, write_sheet, xlsx_bytes
from app.business.orders.queries import list_orders as orders_list_orders
from app.business.orders.router_output import (
    _order_list_payload,
)
from app.business.orders.router_outputs.detail import _order_details_output
from app.business.orders.export_fields import (
    CASHFLOW_EXPORT_COLUMNS,
    DETAIL_COLUMNS_MOVED_TO_SHEETS,
    DETAIL_EXPORT_HEADER_GROUPS,
    DETAIL_EXPORT_SUB_GROUPS,
    ORDER_DETAIL_EXPORT_COLUMNS,
    ORDER_EVENT_EXPORT_COLUMNS,
    REBATE_EXPORT_COLUMNS,
    _cashflow_export_rows,
    _order_detail_export_fields,
    _order_event_export_rows,
    _pool_name_map,
    _rebate_export_rows,
    user_name_map,
)

# 订单类型 → 库存业务类型：与前端 InventoryPanel.inventoryTypeOfOrder 的
# 「无账号时按订单类型兜底」同口径（HS 回收 / TH 提号 / DG 代挂）。
_INVENTORY_TYPE_BY_ORDER_TYPE = {"HS": "RECOVERY", "TH": "PICKUP", "DG": "CONSIGNMENT"}


def _detail_value_labels(db: Session) -> dict[str, dict[str, str]]:
    """明细 JSON 列额外的动态字典：按 JSON 字段键取 option_sets 选项词典翻译。

    首批只接包赔类型（COMPENSATION_TYPE，管理员可编辑）；明细键翻译的静态部分
    由 lists.export_labels 承担，动态字典优先于静态表。
    """
    labels = list_columns_service.option_labels_by_code(db, ("COMPENSATION_TYPE",))
    compensation = labels.get("COMPENSATION_TYPE")
    return {"compensation_type": compensation} if compensation else {}

export_router = APIRouter(tags=["ORD-01/02 订单与事件"])
read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)


@export_router.get("/orders/export.csv")
def export_orders_csv(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
    business_mode: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    account_status: str | None = Query(default=None),
    inventory_operator_ids: list[int] | None = Query(default=None),
    sale_operator_ids: list[int] | None = Query(default=None),
    mine: bool = Query(default=False),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> Response:
    """订单台账按「设置 → 列表字段」的可见列导出 CSV：同 /orders 筛选口径，全量不分页。
    mine=true 时与「我的订单」视图一致，只导出我负责/我执行的订单。"""
    orders = orders_list_orders(
        db,
        order_type=order_type,
        status=status,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=owner_id,
        pool_id=pool_id,
        keyword=keyword,
        business_mode=business_mode,
        game_type=game_type,
        account_status=account_status,
        inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids,
        mine=mine,
        limit=None,
        offset=0,
        user=_user,
    )
    rows = _order_list_payload(db, orders)
    value_labels = {
        **list_columns_service.get_value_labels(db, "LEDGER"),
        **_detail_value_labels(db),
    }
    names = user_name_map(db)
    details = _order_details_output(db, orders, _user)
    for row, order, detail_output in zip(rows, orders, details, strict=True):
        detail = detail_output.model_dump(mode="json")
        row.update(_order_detail_export_fields(detail, value_labels, names))
        # 注册表的 `party` 列是前端由 party_name/party_source 合成的派生列，导出前补齐
        row["party"] = " · ".join(
            part for part in (row.get("party_name"), row.get("party_source")) if part
        )
        # 注册表的 `business_mode` / `inventory_type` 列，前端由账号字段/订单类型
        # 渲染函数合成；行数据只有 account_business_mode，导出前补齐同名派生列，
        # 中文文案由静态列字典统一翻译。
        row["business_mode"] = row.get("account_business_mode")
        row["inventory_type"] = _INVENTORY_TYPE_BY_ORDER_TYPE.get(order.order_type)
    csv_text, meta = build_list_csv(
        db,
        "LEDGER",
        rows,
        extra_columns=ORDER_DETAIL_EXPORT_COLUMNS,
    )
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="LEDGER",
        actor=_user.username,
        after={"rows": len(rows), "column_count": meta["column_count"]},
    )
    return file_response(csv_text, f"订单台账-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)


@export_router.get("/orders/export.xlsx")
def export_orders_xlsx(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
    business_mode: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    account_status: str | None = Query(default=None),
    inventory_operator_ids: list[int] | None = Query(default=None),
    sale_operator_ids: list[int] | None = Query(default=None),
    mine: bool = Query(default=False),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> Response:
    """订单台账导出 Excel：Sheet「主订单信息」= 列表可见列，Sheet「详情信息」= 订单详情全字段。

    与 /orders/export.csv 同筛选口径、同全量不分页口径；两个 sheet 靠「订单号」关联，
    故详情 sheet 首列固定带订单号。详情 sheet 用两级表头，一级板块为真合并单元格。
    """
    orders = orders_list_orders(
        db,
        order_type=order_type,
        status=status,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=owner_id,
        pool_id=pool_id,
        keyword=keyword,
        business_mode=business_mode,
        game_type=game_type,
        account_status=account_status,
        inventory_operator_ids=inventory_operator_ids,
        sale_operator_ids=sale_operator_ids,
        mine=mine,
        limit=None,
        offset=0,
        user=_user,
    )
    rows = _order_list_payload(db, orders)
    value_labels = merge_static_value_labels(
        {
            **list_columns_service.get_value_labels(db, "LEDGER"),
            **_detail_value_labels(db),
        }
    )
    names = user_name_map(db)
    # 注册表的 `party` 列是前端由 party_name/party_source 合成的派生列，导出前补齐
    for row, order in zip(rows, orders, strict=True):
        row["party"] = " · ".join(
            part for part in (row.get("party_name"), row.get("party_source")) if part
        )
        # `business_mode` / `inventory_type` 派生列：口径同 CSV 导出
        row["business_mode"] = row.get("account_business_mode")
        row["inventory_type"] = _INVENTORY_TYPE_BY_ORDER_TYPE.get(order.order_type)
    detail_rows: list[dict[str, object]] = []
    event_rows: list[dict[str, object]] = []
    cashflow_rows: list[dict[str, object]] = []
    rebate_rows: list[dict[str, object]] = []
    pool_names = _pool_name_map(db)
    details = _order_details_output(db, orders, _user)
    for row, order, detail_output in zip(rows, orders, details, strict=True):
        detail = detail_output.model_dump(mode="json")
        order_no = row.get("order_no")
        detail_rows.append(
            {"order_no": order_no, **_order_detail_export_fields(detail, value_labels, names)}
        )
        event_rows.extend(_order_event_export_rows(order_no, detail))
        cashflow_rows.extend(_cashflow_export_rows(order_no, detail, pool_names))
        rebate_rows.extend(_rebate_export_rows(order_no, detail))

    config = list_columns_service.get_config(db, "LEDGER")
    main_columns = [
        (column["key"], column["label"], column["is_visible"])
        for column in config["columns"]
        if column["key"] not in UI_ONLY_KEYS
    ]
    main_rows = inject_custom_columns(rows, config)

    workbook = new_workbook()
    write_sheet(
        workbook,
        title="主订单信息",
        rows=main_rows,
        columns=main_columns,
        value_labels=value_labels,
    )
    write_sheet(
        workbook,
        title="详情信息",
        rows=detail_rows,
        columns=[
            ("order_no", "订单号", True),
            *(
                column
                for column in ORDER_DETAIL_EXPORT_COLUMNS
                if column[0] not in DETAIL_COLUMNS_MOVED_TO_SHEETS
            ),
        ],
        value_labels=value_labels,
        header_groups={
            key: value
            for key, value in DETAIL_EXPORT_HEADER_GROUPS.items()
            if key not in DETAIL_COLUMNS_MOVED_TO_SHEETS
        },
        sub_header_groups=DETAIL_EXPORT_SUB_GROUPS,
    )

    # 三类明细各占一个 sheet：一单多行，列即字段，便于筛选与求和
    option_labels = list_columns_service.option_labels_by_code(
        db,
        (
            "ORDER_EVENT_TYPE",
            "FUND_FLOW_DIRECTION",
            "REBATE_TYPE",
        ),
    )
    # 操作明细：事件类型是「动作」，不再有金额归属（本金/利润/总额）这类系统口径列
    write_sheet(
        workbook,
        title="操作明细",
        rows=event_rows,
        columns=ORDER_EVENT_EXPORT_COLUMNS,
        value_labels={"event_type": option_labels.get("ORDER_EVENT_TYPE", {})},
    )
    # 资金明细：类别使用资金原因编码（SALE/INSTALLMENT_PAYMENT 等），不复用订单事件编码；
    # 现金性质与方向重复，已从列里移除，不再需要该枚举
    write_sheet(
        workbook,
        title="资金明细",
        rows=cashflow_rows,
        columns=CASHFLOW_EXPORT_COLUMNS,
        value_labels={
            "category": option_labels.get("ORDER_EVENT_TYPE", {}),
            "direction": option_labels.get("FUND_FLOW_DIRECTION", {}),
        },
    )
    write_sheet(
        workbook,
        title="返点明细",
        rows=rebate_rows,
        columns=REBATE_EXPORT_COLUMNS,
        value_labels={
            "rebate_type": option_labels.get("REBATE_TYPE", {}),
        },
    )
    content = xlsx_bytes(workbook)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="LEDGER",
        actor=_user.username,
        after={
            "rows": len(rows),
            "column_count": sum(1 for _key, _label, visible in main_columns if visible),
            "format": "xlsx",
            "sheets": ["主订单信息", "详情信息", "操作明细", "资金明细", "返点明细"],
            "detail_rows": {
                "events": len(event_rows),
                "cashflows": len(cashflow_rows),
                "rebates": len(rebate_rows),
            },
        },
    )
    return file_response(content, f"订单台账-{date.today().isoformat()}.xlsx", XLSX_MEDIA_TYPE)


