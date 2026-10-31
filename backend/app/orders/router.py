"""orders.router：订单、事件与资金池余额 API（ORD-01/02、FIN-01）。

金额类动作全部走 Service 事务；列表页只提供查询，不做直接登记。
"""

from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.database import get_db
from app.core.errors import PermissionDenied, Validation
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
from app.value_added_services import service as installments_service
from app.lists import service as list_columns_service
from app.lists.export import EXPORT_ROW_LIMIT, build_list_csv, csv_file_response, detail_json
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
    ("detail_events", "操作明细", True),
    ("detail_cashflows", "资金明细", True),
    ("detail_rebates", "返点明细", True),
    ("detail_installment", "分期合约", True),
    ("detail_installment_schedule", "分期计划", True),
    ("detail_links", "关联订单", True),
    ("detail_attachments", "附件", True),
    ("detail_audit", "审计记录", True),
]


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
        "detail_buy_delivery_phone": form_extra.get("bound_phone"),
        "detail_buy_delivery_owner": form_extra.get("bound_phone_owner"),
        "detail_buy_delivery_platform": form_extra.get("intermediary_platform"),
        "detail_buy_delivery_type": form_extra.get("intermediary_type"),
        "detail_buy_delivery_compensation": form_extra.get("compensation_type"),
        "detail_buy_delivery_responsible": detail_json(form_extra.get("delivery_responsible_ids") or [], value_labels),
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
