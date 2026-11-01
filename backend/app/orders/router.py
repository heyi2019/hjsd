"""orders.router：订单、事件与资金池余额 API（ORD-01/02、FIN-01）。

金额类动作全部走 Service 事务；列表页只提供查询，不做直接登记。
"""

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.database import get_db
from app.core.errors import PermissionDenied, Validation
from app.core.money import to_money
from app.core.schemas import PageOut
from app.core.security import (
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    CurrentUser,
    require_permissions,
)
from app.domain.enums import AuditAction
from app.domain.foundation import Pool
from app.domain.options import OptionSet
from app.value_added_services import service as installments_service
from app.lists import service as list_columns_service
from app.lists.export import (
    EXPORT_ROW_LIMIT,
    UI_ONLY_KEYS,
    build_list_csv,
    csv_file_response,
    detail_json,
    inject_custom_columns,
)
from app.lists.xlsx import new_workbook, write_sheet, xlsx_bytes, xlsx_file_response
from app.orders import schemas, service

from .router_output import (
    _actor,
    _order_output,
    _operator_names,
    _event_output,
    _order_detail_output,
    _order_list_payload,
)

router = APIRouter(tags=["ORD-01/02 订单与事件"])

ORDER_DETAIL_EXPORT_COLUMNS = [
    ("detail_account_password", "账号密码", True),
    ("detail_account_channel_region", "渠道 / 区服", True),
    ("detail_account_bound_phone", "绑定手机号", True),
    ("detail_account_secondary", "有无二次", True),
    ("detail_account_description", "账号描述", True),
    ("detail_account_images", "账号图片", True),
    ("detail_order_note", "订单备注", True),
    ("detail_order_extra", "订单扩展字段", True),
    ("detail_buy_delivery_phone", "买号交付-换绑手机号", True),
    ("detail_buy_delivery_owner", "买号交付-手机号绑定人", True),
    ("detail_buy_delivery_platform", "买号交付-交易平台", True),
    ("detail_buy_delivery_type", "买号交付-中介类型", True),
    ("detail_buy_delivery_compensation", "买号交付-包赔类型", True),
    ("detail_buy_delivery_responsible", "买号交付-交付负责人", True),
    ("detail_sell_delivery_phone", "卖号交付-换绑手机号", True),
    ("detail_sell_delivery_owner", "卖号交付-手机号绑定人", True),
    ("detail_sell_delivery_platform", "卖号交付-交易平台", True),
    ("detail_sell_delivery_type", "卖号交付-中介类型", True),
    ("detail_sell_delivery_compensation", "卖号交付-包赔类型", True),
    ("detail_sell_delivery_responsible", "卖号交付-交付负责人", True),
    ("detail_events", "操作明细", True),
    ("detail_cashflows", "资金明细", True),
    ("detail_rebates", "返点明细", True),
    ("detail_installment", "分期合约", True),
    ("detail_installment_schedule", "分期计划", True),
    ("detail_links", "关联订单", True),
    ("detail_attachments", "附件", True),
    ("detail_audit", "审计记录", True),
]

# xlsx「详情信息」sheet 的分组表头：{列键: 一级板块名}，一级为真合并单元格。
# 只用于 /orders/export.xlsx；CSV 一律单行表头（导入解析以首个非空行为表头，多行会错位）。
# 详情 sheet 单独带「订单标识」组，用来承载跨 sheet 关联键（订单号）。
DETAIL_EXPORT_HEADER_GROUPS: dict[str, str] = {
    "order_no": "订单标识",
    "detail_account_password": "账号详情",
    "detail_account_channel_region": "账号详情",
    "detail_account_bound_phone": "账号详情",
    "detail_account_secondary": "账号详情",
    "detail_account_description": "账号详情",
    "detail_account_images": "账号详情",
    "detail_order_note": "订单信息",
    "detail_order_extra": "订单信息",
    "detail_buy_delivery_phone": "交付信息",
    "detail_buy_delivery_owner": "交付信息",
    "detail_buy_delivery_platform": "交付信息",
    "detail_buy_delivery_type": "交付信息",
    "detail_buy_delivery_compensation": "交付信息",
    "detail_buy_delivery_responsible": "交付信息",
    "detail_sell_delivery_phone": "交付信息",
    "detail_sell_delivery_owner": "交付信息",
    "detail_sell_delivery_platform": "交付信息",
    "detail_sell_delivery_type": "交付信息",
    "detail_sell_delivery_compensation": "交付信息",
    "detail_sell_delivery_responsible": "交付信息",
    "detail_events": "明细记录",
    "detail_cashflows": "明细记录",
    "detail_rebates": "明细记录",
    "detail_installment": "明细记录",
    "detail_installment_schedule": "明细记录",
    "detail_links": "明细记录",
    "detail_attachments": "明细记录",
    "detail_audit": "明细记录",
}

# xlsx「详情信息」sheet 的二级分组：{列键: 二级组名}。
# 只在「交付信息」下使用——同一套交付字段在不同订单角色下分属买号交付 / 卖号交付，
# 拆成两组后每张订单只在其中一组有值，另一组整行留空，比单一「交付方向」标注更直观。
DETAIL_EXPORT_SUB_GROUPS: dict[str, str] = {
    "detail_buy_delivery_phone": "买号交付",
    "detail_buy_delivery_owner": "买号交付",
    "detail_buy_delivery_platform": "买号交付",
    "detail_buy_delivery_type": "买号交付",
    "detail_buy_delivery_compensation": "买号交付",
    "detail_buy_delivery_responsible": "买号交付",
    "detail_sell_delivery_phone": "卖号交付",
    "detail_sell_delivery_owner": "卖号交付",
    "detail_sell_delivery_platform": "卖号交付",
    "detail_sell_delivery_type": "卖号交付",
    "detail_sell_delivery_compensation": "卖号交付",
    "detail_sell_delivery_responsible": "卖号交付",
}


# 明细类 sheet 的列定义：把原本塞在单个单元格里的 JSON 明细拆成真正的列。
# 一单多行、以「订单号」与主/详情 sheet 关联，Excel 里可直接筛选、求和、做透视。
#
# 列集合与界面「操作明细 / 资金明细」保持同一套业务口径：界面没有的系统内部字段
# （事件号、流水号、是否过账、金额归属）一律不出现，界面有的「平台」要补上，
# 否则同一个人从界面切到导出会看到两套列。
ORDER_EVENT_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("operation_category", "操作分类", True),
    ("event_type", "动作", True),
    ("platform", "平台", True),
    ("occurred_on", "动作时间", True),
    ("operator", "操作人", True),
    ("amount", "金额", True),
    ("note", "备注", True),
]

# 「现金性质」与「方向」是同一信息的两种写法（本方流入⟺收入、本方流出⟺支出，实测一一对应），
# 只保留业务人员看得懂的「方向」；流水号属系统编号，不导出。
CASHFLOW_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("category", "业务类别", True),
    ("direction", "方向", True),
    ("amount", "金额", True),
    ("occurred_on", "时间", True),
    ("status", "状态", True),
    ("operator", "操作人", True),
    ("pool_name", "资金池", True),
    ("note", "备注", True),
]

REBATE_EXPORT_COLUMNS = [
    ("order_no", "订单号", True),
    ("rebate_no", "返点单号", True),
    ("rebate_type", "返点类型", True),
    ("channel", "渠道", True),
    ("rate", "费率(%)", True),
    ("base_amount", "基数", True),
    ("rebate_amount", "返点金额", True),
    ("link_status", "关联状态", True),
    ("status", "状态", True),
    ("collected_on", "收到日期", True),
    ("operator", "操作人", True),
    ("note", "备注", True),
]

# 已拆成独立 sheet 的明细列：xlsx 详情 sheet 里不再重复输出 JSON 版本，
# CSV 是单表格式没有承载位置，仍保留这些 JSON 列。
DETAIL_COLUMNS_MOVED_TO_SHEETS = frozenset(
    {"detail_events", "detail_cashflows", "detail_rebates"}
)

# 返点状态码没有对应的 option_sets 字典项（RebateStatus 是闭集枚举），
# 这里按枚举给中文，与前端状态标签保持同一套文案。
_REBATE_STATUS_LABELS = {
    "OPEN": "未结算",
    "PARTIALLY_SETTLED": "部分结算",
    "SETTLED": "已结清",
    "VOID": "失效",
}

# 操作分类与前端执行明细同规则：BUY 买号入库 / SELL 卖号出库 / 其余账号运营。
_OPERATION_CATEGORY_BY_EVENT = {"BUY": "买号入库", "SELL": "卖号出库"}
_OPERATION_CATEGORY_FALLBACK = "账号运营"


def _operation_category(event_type: str | None) -> str:
    return _OPERATION_CATEGORY_BY_EVENT.get(event_type or "", _OPERATION_CATEGORY_FALLBACK)


def _money_or_none(value: object) -> Decimal | None:
    """明细金额转 2 位 Decimal：xlsx 写成数值才可求和；空值保持空单元格。"""
    if value is None or value == "":
        return None
    try:
        return to_money(value)
    except ValueError:
        return None


def _option_value_labels(db: Session, codes: tuple[str, ...]) -> dict[str, dict[str, str]]:
    """按字典 code 批量取 {代码值: 中文}；字典缺失或选项为空时该组为空，导出保留原值。"""
    labels: dict[str, dict[str, str]] = {}
    for row in db.scalars(select(OptionSet).where(OptionSet.code.in_(codes))).all():
        options = row.options if isinstance(row.options, list) else []
        labels[row.code] = {
            str(item["value"]): str(item["label"])
            for item in options
            if isinstance(item, dict)
            and item.get("value") is not None
            and item.get("label") is not None
        }
    return labels


def _pool_name_map(db: Session) -> dict[int, str]:
    return {pool.id: pool.name for pool in db.scalars(select(Pool)).all()}


def _event_platform(event: dict, detail: dict, account_platform: str | None) -> str | None:
    """事件的「平台」列，与库存视角的执行明细同口径。

    - 非下架事件：订单自身账号所在平台；
    - 下架（CANCEL）事件按「下架方式」区分：系统下架记「本系统」，平台下架记寄售平台，
      缺寄售平台时回落到账号平台。
    库存视角还会跨单判断「账号内是否存在 SYSTEM 下架单」，订单粒度拿不到同账号其它订单，
    这里不做该兜底，落单更常见的一档。
    """
    if event.get("event_type") != "CANCEL":
        return account_platform
    extra = detail.get("form_extra") or {}
    if extra.get("platform_unlist_scope") == "SYSTEM":
        return "本系统"
    return extra.get("consignment_platform") or account_platform


def _order_event_export_rows(
    order_no: str, detail: dict, account_platform: str | None
) -> list[dict[str, object]]:
    return [
        {
            "order_no": order_no,
            "operation_category": _operation_category(event.get("event_type")),
            "event_type": event.get("event_type"),
            "platform": _event_platform(event, detail, account_platform),
            "occurred_on": event.get("occurred_on"),
            "operator": event.get("operator"),
            "amount": _money_or_none(event.get("amount")),
            "note": event.get("note"),
        }
        for event in detail.get("events") or []
    ]


def _cashflow_export_rows(
    order_no: str, detail: dict, pool_names: dict[int, str]
) -> list[dict[str, object]]:
    return [
        {
            "order_no": order_no,
            "category": flow.get("category"),
            "direction": flow.get("direction"),
            "amount": _money_or_none(flow.get("amount")),
            "occurred_on": flow.get("occurred_on"),
            "status": flow.get("status"),
            "operator": flow.get("operator"),
            "pool_name": pool_names.get(flow.get("pool_id")),
            "note": flow.get("note"),
        }
        for flow in detail.get("cashflows") or []
    ]


def _rebate_export_rows(order_no: str, detail: dict) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for rebate in detail.get("rebates") or []:
        base_amount = _money_or_none(rebate.get("base_amount"))
        rate = _money_or_none(rebate.get("rate"))
        # 返点金额 = 基数 × 费率%，Decimal 计算后由 to_money 统一量化到 2 位
        amount = (
            to_money(base_amount * rate / Decimal("100"))
            if base_amount is not None and rate is not None
            else None
        )
        rows.append(
            {
                "order_no": order_no,
                "rebate_no": rebate.get("rebate_no"),
                "rebate_type": rebate.get("rebate_type"),
                "channel": rebate.get("channel"),
                "rate": rate,
                "base_amount": base_amount,
                "rebate_amount": amount,
                "link_status": rebate.get("link_status"),
                "status": rebate.get("status"),
                "collected_on": rebate.get("collected_on"),
                "operator": rebate.get("operator"),
                "note": rebate.get("note"),
            }
        )
    return rows


def _delivery_direction(detail: dict) -> str:
    """判定订单的交付方向：买单交付给卖家，卖单交付给买家。

    - 已登记 SELL 事件 → 这张单是「卖出去」的那一单，交付对象是买家 → 卖号交付；
    - DG 代挂（零本金、建单即纳入库存代卖）→ 无论是否已成交都是替客户卖 → 卖号交付；
    - 其余（HS 回收 / TH 提号中纯买入未成交的单）→ 买号交付。
    与库存视角的「卖号交付单」判定同源（含 SELL 事件，或 DG 单）。
    """
    if detail.get("order_type") == "DG":
        return "卖号交付"
    events = detail.get("events") or []
    if any(event.get("event_type") == "SELL" for event in events):
        return "卖号交付"
    return "买号交付"


def _delivery_export_fields(detail: dict, value_labels: dict[str, dict[str, str]]) -> dict[str, str | None]:
    """把同一套交付字段按订单角色归入「买号交付」或「卖号交付」，另一组整组留空。

    交付字段都存在订单自己的 `form_extra` 里，语义随订单角色变化：
    买入未成交的单是对卖家的交接，卖出过的单与 DG 代挂单是对买家的交接。
    两组并存而非只标方向，是为了让人一眼看出这张单属于哪种交付。
    """
    form_extra = detail.get("form_extra") or {}
    values: dict[str, str | None] = {
        "phone": form_extra.get("bound_phone"),
        "owner": form_extra.get("bound_phone_owner"),
        "platform": form_extra.get("intermediary_platform"),
        "type": form_extra.get("intermediary_type"),
        "compensation": form_extra.get("compensation_type"),
        "responsible": detail_json(
            form_extra.get("delivery_responsible_ids") or [], value_labels
        ),
    }
    is_buy = _delivery_direction(detail) == "买号交付"
    buy_values = values if is_buy else dict.fromkeys(values)
    sell_values = dict.fromkeys(values) if is_buy else values
    return {
        **{f"detail_buy_delivery_{suffix}": value for suffix, value in buy_values.items()},
        **{f"detail_sell_delivery_{suffix}": value for suffix, value in sell_values.items()},
    }


def _order_detail_export_fields(detail: dict, value_labels: dict[str, dict[str, str]]) -> dict[str, str | None]:
    account = detail.get("account_snapshot") or {}
    form_extra = detail.get("form_extra") or {}
    return {
        "detail_account_password": account.get("game_password"),
        "detail_account_channel_region": account.get("channel_region"),
        "detail_account_bound_phone": account.get("bound_phone"),
        "detail_account_secondary": account.get("has_secondary"),
        "detail_account_description": account.get("account_description"),
        "detail_account_images": detail_json(account.get("account_images") or [], value_labels),
        "detail_order_note": detail.get("note"),
        "detail_order_extra": detail_json(form_extra, value_labels),
        **_delivery_export_fields(detail, value_labels),
        "detail_events": detail_json(detail.get("events") or [], value_labels),
        "detail_cashflows": detail_json(detail.get("cashflows") or [], value_labels),
        "detail_rebates": detail_json(detail.get("rebates") or [], value_labels),
        "detail_installment": detail_json(detail.get("installment"), value_labels),
        "detail_installment_schedule": detail_json(detail.get("installment_schedule") or [], value_labels),
        "detail_links": detail_json(detail.get("links") or [], value_labels),
        "detail_attachments": detail_json(detail.get("attachments") or [], value_labels),
        "detail_audit": detail_json(detail.get("audit") or [], value_labels),
    }

read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
read_finance = require_permissions(PERM_FINANCE_READ)


@router.get("/orders", response_model=PageOut[schemas.OrderListOut])
def list_orders(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
    mine: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> list[schemas.OrderListOut]:
    orders = service.list_orders(
        db,
        order_type=order_type,
        status=status,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=owner_id,
        pool_id=pool_id,
        keyword=keyword,
        mine=mine,
        limit=limit,
        offset=offset,
        user=_user,
    )
    return PageOut(
        items=[schemas.OrderListOut.model_validate(item) for item in _order_list_payload(db, orders)],
        total=service.count_orders(
            db, order_type=order_type, status=status, trade_date_from=trade_date_from,
            trade_date_to=trade_date_to, owner_id=owner_id, pool_id=pool_id,
            keyword=keyword, user=_user, mine=mine,
        ),
        limit=limit,
        offset=offset,
    )


@router.get("/orders/export.csv")
def export_orders_csv(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> Response:
    """订单台账按「设置 → 列表字段」的可见列导出 CSV：同 /orders 筛选口径，全量不分页。"""
    orders = service.list_orders(
        db,
        order_type=order_type,
        status=status,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=owner_id,
        pool_id=pool_id,
        keyword=keyword,
        limit=EXPORT_ROW_LIMIT,
        offset=0,
        user=_user,
    )
    rows = _order_list_payload(db, orders)
    value_labels = list_columns_service.get_value_labels(db, "LEDGER")
    for row, order in zip(rows, orders, strict=True):
        detail = _order_detail_output(db, order, _user).model_dump(mode="json")
        row.update(_order_detail_export_fields(detail, value_labels))
    # 注册表的 `party` 列是前端由 party_name/party_source 合成的派生列，导出前补齐
    for row in rows:
        row["party"] = " · ".join(
            part for part in (row.get("party_name"), row.get("party_source")) if part
        )
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
    return csv_file_response(csv_text, f"订单台账-{date.today().isoformat()}.csv")


@router.get("/orders/export.xlsx")
def export_orders_xlsx(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> Response:
    """订单台账导出 Excel：Sheet「主订单信息」= 列表可见列，Sheet「详情信息」= 订单详情全字段。

    与 /orders/export.csv 同筛选口径、同全量不分页上限；两个 sheet 靠「订单号」关联，
    故详情 sheet 首列固定带订单号。详情 sheet 用两级表头，一级板块为真合并单元格。
    """
    orders = service.list_orders(
        db,
        order_type=order_type,
        status=status,
        trade_date_from=trade_date_from,
        trade_date_to=trade_date_to,
        owner_id=owner_id,
        pool_id=pool_id,
        keyword=keyword,
        limit=EXPORT_ROW_LIMIT,
        offset=0,
        user=_user,
    )
    rows = _order_list_payload(db, orders)
    value_labels = list_columns_service.get_value_labels(db, "LEDGER")
    # 注册表的 `party` 列是前端由 party_name/party_source 合成的派生列，导出前补齐
    for row in rows:
        row["party"] = " · ".join(
            part for part in (row.get("party_name"), row.get("party_source")) if part
        )
    detail_rows: list[dict[str, object]] = []
    event_rows: list[dict[str, object]] = []
    cashflow_rows: list[dict[str, object]] = []
    rebate_rows: list[dict[str, object]] = []
    pool_names = _pool_name_map(db)
    for row, order in zip(rows, orders, strict=True):
        detail = _order_detail_output(db, order, _user).model_dump(mode="json")
        order_no = row.get("order_no")
        detail_rows.append(
            {"order_no": order_no, **_order_detail_export_fields(detail, value_labels)}
        )
        event_rows.extend(
            _order_event_export_rows(order_no, detail, row.get("account_platform"))
        )
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
    option_labels = _option_value_labels(
        db,
        (
            "ORDER_EVENT_TYPE",
            "FUND_FLOW_DIRECTION",
            "FUND_FLOW_STATUS",
            "REBATE_TYPE",
            "ORDER_LINK_STATUS",
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
    # 资金明细：类别与事件类型同值域（BUY/SELL/PAYMENT），复用同一组字典；
    # 现金性质与方向重复，已从列里移除，不再需要 CASHFLOW_NATURE
    write_sheet(
        workbook,
        title="资金明细",
        rows=cashflow_rows,
        columns=CASHFLOW_EXPORT_COLUMNS,
        value_labels={
            "category": option_labels.get("ORDER_EVENT_TYPE", {}),
            "direction": option_labels.get("FUND_FLOW_DIRECTION", {}),
            "status": option_labels.get("FUND_FLOW_STATUS", {}),
        },
    )
    write_sheet(
        workbook,
        title="返点明细",
        rows=rebate_rows,
        columns=REBATE_EXPORT_COLUMNS,
        value_labels={
            "rebate_type": option_labels.get("REBATE_TYPE", {}),
            "link_status": option_labels.get("ORDER_LINK_STATUS", {}),
            "status": _REBATE_STATUS_LABELS,
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
    return xlsx_file_response(content, f"订单台账-{date.today().isoformat()}.xlsx")


@router.post("/orders", response_model=schemas.OrderOut, status_code=201)
def create_order(
    payload: schemas.OrderCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = create_orders,
) -> schemas.OrderOut:
    normalized_order_type = payload.order_type.strip().upper()
    if payload.installment is not None and normalized_order_type in {"TH", "DG"}:
        raise Validation("TH/DG 分期必须在出售动作中选择付款方式并建立分期合约")
    if payload.initial_buy is None and payload.installment is not None and normalized_order_type != "DG":
        raise Validation("TH 分期订单必须同时提交初始买入和分期合约")
    expected_contract_type = {
        "TH": "PICKUP_SALE",
        "DG": "CONSIGNMENT_SALE",
    }.get(normalized_order_type)
    if payload.installment is not None and payload.installment.contract_type != expected_contract_type:
        raise Validation(
            f"{normalized_order_type} 订单必须使用 {expected_contract_type} 分期合约",
            details={"contract_type": payload.installment.contract_type},
        )
    if payload.initial_buy is not None and normalized_order_type not in {"HS", "TH"}:
        raise Validation("只有 HS 或 TH 订单可以在创建时提交初始买入")
    if payload.initial_costs and (normalized_order_type not in {"HS", "TH"} or payload.initial_buy is None):
        raise Validation("初始费用仅适用于同时提交初始买入的回收或提号订单")
    if normalized_order_type in {"HS", "TH"} and payload.initial_buy is not None:
        if not (user.has(PERM_ORDER_EVENT_POST) or user.has(PERM_FINANCE_ORDER_EVENT_POST)):
            raise PermissionDenied("无权登记买入事件")
        if payload.initial_costs and not user.has(PERM_ORDER_EVENT_POST):
            raise PermissionDenied("无权登记费用事件")
    owner_id = (
        payload.owner_id
        if user.is_admin or user.owner_scope == "ALL"
        else user.id
    )
    order = service.create_order(
        db,
        order_type=normalized_order_type,
        trade_date=payload.trade_date,
        account_snapshot=(
            payload.account_snapshot.model_dump(exclude_none=True)
            if payload.account_snapshot is not None
            else None
        ),
        actor=_actor(user),
        account_id=payload.account_id,
        owner_id=owner_id,
        capital_type=payload.capital_type,
        note=payload.note,
        commission_mode=payload.commission_mode,
        commission_payer=payload.commission_payer,
        customer_roles=[
            (role.customer_id, role.role)
            for role in payload.customer_roles
            if role.customer_id is not None
        ],
        counterparty_roles=[
            (role.counterparty_id, role.role)
            for role in payload.counterparty_roles
            if role.counterparty_id is not None
        ],
        extra_values=payload.extra_values,
        form_extra=payload.form_extra,
        form_extra_scope=payload.form_extra_scope,
        user=user,
    )
    if payload.installment is not None:
        installments_service.create_installment(
            db,
            order_id=order.id,
            contract_type=payload.installment.contract_type,
            principal=payload.installment.principal,
            down_payment=payload.installment.down_payment,
            service_fee=payload.installment.service_fee,
            periods=payload.installment.periods,
            per_period_service_fee=payload.installment.per_period_service_fee,
            per_period=payload.installment.per_period,
            adjust_final_period=payload.installment.adjust_final_period,
            first_due_on=payload.installment.first_due_on,
            delivery_mode=payload.installment.delivery_mode,
            note=payload.installment.note,
            schedule=(
                [item.model_dump() for item in payload.installment.schedule]
                if payload.installment.schedule
                else None
            ),
            actor=_actor(user),
            user=user,
        )
    if payload.initial_buy is not None:
        service.post_event(
            db,
            order.id,
            event_type="BUY",
            amount=payload.initial_buy.amount,
            occurred_on=payload.initial_buy.occurred_on,
            actor=_actor(user),
            pool_id=payload.initial_buy.pool_id,
            portion=payload.initial_buy.portion,
            note=payload.initial_buy.note,
            user=user,
        )
    for cost in payload.initial_costs:
        service.post_event(
            db, order.id, event_type="COST", amount=cost.amount,
            occurred_on=cost.occurred_on, actor=_actor(user), pool_id=cost.pool_id,
            portion=cost.portion, flow_category=cost.flow_category, note=cost.note, user=user,
        )
    return _order_output(db, order, user)


@router.get("/orders/{order_id}", response_model=schemas.OrderDetailOut)
def get_order(
    order_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_orders,
) -> schemas.OrderDetailOut:
    return _order_detail_output(db, service.get_order(db, order_id, _user), _user)


@router.get("/orders/{order_id}/links", response_model=list[schemas.OrderLinkOut])
def list_order_links(
    order_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = read_orders,
) -> list[schemas.OrderLinkOut]:
    return [
        schemas.OrderLinkOut.model_validate(item)
        for item in service.list_order_links(db, order_id, user)
    ]


@router.post(
    "/orders/{order_id}/links",
    response_model=schemas.OrderLinkOut,
    status_code=201,
)
def create_order_link(
    order_id: int,
    payload: schemas.OrderLinkCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderLinkOut:
    link = service.create_order_link(
        db,
        order_id,
        related_order_id=payload.related_order_id,
        relation_type=payload.relation_type,
        split_ratio=payload.split_ratio,
        split_amount=payload.split_amount,
        note=payload.note,
        form_extra=payload.form_extra,
        actor=_actor(user),
        user=user,
    )
    item = next(
        item for item in service.list_order_links(db, order_id, user) if item["id"] == link.id
    )
    return schemas.OrderLinkOut.model_validate(item)


@router.delete("/orders/{order_id}/links/{link_id}", status_code=204, response_model=None)
def delete_order_link(
    order_id: int,
    link_id: int,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> None:
    service.delete_order_link(db, order_id, link_id, actor=_actor(user), user=user)


@router.patch("/orders/{order_id}", response_model=schemas.OrderOut)
def update_order(
    order_id: int,
    payload: schemas.OrderUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    changes = {
        field: getattr(payload, field)
        for field in payload.model_fields_set
    }
    if "account_snapshot" in changes and changes["account_snapshot"] is not None:
        changes["account_snapshot"] = changes["account_snapshot"].model_dump()
    order = service.update_order(
        db, order_id, actor=_actor(user), user=user, **changes
    )
    return _order_output(db, order, user)


@router.post("/orders/{order_id}/cancel", response_model=schemas.OrderOut)
def cancel_order(
    order_id: int,
    payload: schemas.OrderCancelIn,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    order = service.cancel_order(
        db,
        order_id,
        actor=_actor(user),
        reason=payload.reason,
        form_extra=payload.form_extra,
        form_extra_scope=payload.form_extra_scope,
        user=user,
    )
    return _order_output(db, order, user)


@router.post("/orders/{order_id}/events", response_model=schemas.EventPostResult, status_code=201)
def post_event(
    order_id: int,
    payload: schemas.EventCreate,
    db: Session = Depends(get_db),
    user: CurrentUser = post_events,
) -> schemas.EventPostResult:
    service.get_order(db, order_id, user)
    event_type = payload.event_type.strip().upper()
    if user.has(PERM_FINANCE_ORDER_EVENT_POST) and not user.has(PERM_ORDER_EVENT_POST):
        if event_type not in {"BUY", "SELL"}:
            raise PermissionDenied(
                "财务只能登记付款或回款事件",
                details={"allowed_event_types": ["BUY", "SELL"], "event_type": event_type},
            )
    event, flow = service.post_event(
        db,
        order_id,
        event_type=event_type,
        amount=payload.amount,
        occurred_on=payload.occurred_on,
        actor=_actor(user),
        pool_id=payload.pool_id,
        pool_id2=payload.pool_id2,
        amount2=payload.amount2,
        portion=payload.portion,
        delivery_mode=payload.delivery_mode,
        offset_event_id=payload.offset_event_id,
        reason=payload.reason,
        refund_responsibility=payload.refund_responsibility,
        operator_user_ids=payload.operator_user_ids,
        flow_category=payload.flow_category,
        note=payload.note,
        bound_phone=payload.bound_phone,
        bound_phone_owner=payload.bound_phone_owner,
        form_extra_scope=payload.form_extra_scope,
        form_extra=payload.form_extra,
        user=user,
    )
    return schemas.EventPostResult(
        event=_event_output(event, _operator_names(db, [event])),
        cashflow_no=flow.flow_no if flow else None,
    )


@router.post("/orders/{order_id}/customer-roles", response_model=schemas.OrderOut)
def add_order_customer_role(
    order_id: int,
    payload: schemas.CustomerRoleInput,
    db: Session = Depends(get_db),
    user: CurrentUser = update_orders,
) -> schemas.OrderOut:
    """向已有订单追加客户角色（如库存售出时把买家挂到来源单）。"""
    service.add_customer_role(
        db, order_id, payload.customer_id, payload.role,
        actor=_actor(user), user=user,
    )
    order = service.get_order(db, order_id, user)
    return _order_output(db, order, user)


@router.get("/pools/{pool_id}/balance", response_model=schemas.PoolBalanceOut)
def pool_balance(
    pool_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_finance,
) -> schemas.PoolBalanceOut:
    if not _user.can_see_pool(pool_id):
        from app.core.errors import NotFound
        raise NotFound("资金池不存在", details={"pool_id": pool_id})
    return schemas.PoolBalanceOut.model_validate(
        service.pool_balance(db, pool_id, user=_user)
    )


__all__ = ["router"]
