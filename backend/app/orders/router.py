"""orders.router：订单、事件与资金池余额 API（ORD-01/02、FIN-01）。

金额类动作全部走 Service 事务；列表页只提供查询，不做直接登记。
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import PermissionDenied, Validation
from app.core.security import (
    PERM_AUDIT_READ,
    PERM_FIELD_DEFINITION_MANAGE,
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    CurrentUser,
    require_permissions,
)
from app.domain.foundation import AuditLog
from app.domain.attachments import Attachment
from app.domain.parties import Customer, Counterparty, OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import (
    Account,
    Cashflow,
    Installment,
    InstallmentSchedule,
    OrderEvent,
    RebateRecord,
)
from app.installments import service as installments_service
from app.orders import schemas, service
from app.orders import form_fields as form_fields_service

router = APIRouter(tags=["ORD-01/02 订单与事件"])

read_orders = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
create_orders = require_permissions(PERM_ORDER_CREATE)
post_events = require_permissions(
    PERM_ORDER_EVENT_POST, PERM_FINANCE_ORDER_EVENT_POST, require_all=False
)
update_orders = require_permissions(PERM_ORDER_UPDATE)
read_finance = require_permissions(PERM_FINANCE_READ)


def _actor(user: CurrentUser) -> str:
    return user.username


def _order_output(db: Session, order, user: CurrentUser) -> schemas.OrderOut:
    """按订单权限输出详情，避免财务/查看权限读取 DFQ 游戏密码。"""
    output = schemas.OrderOut.model_validate(order)
    # 表单字段自定义值落订单 form_extra 列，读取直接回显（BAS-04-03 历史值可查）。
    output.extra_values = dict(order.form_extra or {})
    if not user.has(PERM_ORDER_CREATE) and output.account_snapshot:
        snapshot = dict(output.account_snapshot)
        if "game_password" in snapshot:
            snapshot["game_password"] = None
        output.account_snapshot = snapshot
    return output


def _event_output(event: OrderEvent) -> schemas.EventOut:
    """把审计字段映射为事件响应字段，避免 ORM 属性名泄漏到 API。"""
    return schemas.EventOut.model_validate(
        {
            "id": event.id,
            "event_no": event.event_no,
            "order_id": event.order_id,
            "event_type": event.event_type,
            "amount": event.amount,
            "occurred_on": event.occurred_on,
            "pool_id": event.pool_id,
            "offset_event_id": event.offset_event_id,
            "portion": event.portion,
            "delivery_mode": event.delivery_mode,
            "is_posted": event.is_posted,
            "posted_at": event.posted_at,
            "reason": event.reason,
            "refund_responsibility": event.refund_responsibility,
            "note": event.note,
            "created_at": event.created_at,
            "operator": event.created_by,
        }
    )


def _order_detail_output(
    db: Session, order, user: CurrentUser
) -> schemas.OrderDetailOut:
    """订单详情统一返回主字段和执行事件，避免前端再拼接隐式查询。"""
    output = schemas.OrderDetailOut.model_validate(order)
    # 表单字段自定义值落订单 form_extra 列，读取直接回显（BAS-04-03 历史值可查）。
    output.extra_values = dict(order.form_extra or {})
    if not user.has(PERM_ORDER_CREATE) and output.account_snapshot:
        snapshot = dict(output.account_snapshot)
        if "game_password" in snapshot:
            snapshot["game_password"] = None
        output.account_snapshot = snapshot
    events = db.scalars(
        select(OrderEvent)
        .where(OrderEvent.order_id == order.id)
        .order_by(OrderEvent.occurred_on, OrderEvent.id)
    ).all()
    output.events = [_event_output(event) for event in events]
    output.links = [
        schemas.OrderLinkOut.model_validate(item)
        for item in service.list_order_links(db, order.id, user)
    ]
    if user.has(PERM_FINANCE_READ):
        cashflows = db.scalars(
            select(Cashflow)
            .where(Cashflow.order_id == order.id)
            .order_by(Cashflow.occurred_on, Cashflow.id)
        ).all()
        output.cashflows = [
            schemas.OrderCashflowOut.model_validate(
                {
                    "flow_no": item.flow_no,
                    "pool_id": item.pool_id,
                    "occurred_on": item.occurred_on,
                    "nature": item.nature,
                    "category": item.category,
                    "direction": item.direction,
                    "amount": item.amount,
                    "status": item.status,
                    "order_event_id": item.order_event_id,
                    "note": item.note,
                    "operator": item.created_by,
                }
            )
            for item in cashflows
        ]
        rebates = db.scalars(
            select(RebateRecord)
            .where(RebateRecord.source_order_id == order.id)
            .order_by(RebateRecord.id)
        ).all()
        output.rebates = [
            schemas.OrderRebateOut.model_validate(
                {
                    "id": item.id,
                    "rebate_no": item.rebate_no,
                    "rebate_type": item.rebate_type,
                    "channel": item.channel,
                    "rate": item.rate,
                    "base_amount": item.base_amount,
                    "link_status": item.link_status,
                    "status": item.status,
                    "collected_on": item.collected_on,
                    "expected_on": item.expected_on,
                    "note": item.note,
                    "created_at": item.created_at,
                    "operator": item.created_by,
                }
            )
            for item in rebates
        ]
    installment = db.scalar(
        select(Installment).where(Installment.order_id == order.id)
    )
    if installment is not None:
        output.installment = schemas.OrderInstallmentOut.model_validate(installment)
        schedules = db.scalars(
            select(InstallmentSchedule)
            .where(InstallmentSchedule.installment_id == installment.id)
            .order_by(InstallmentSchedule.period_no)
        ).all()
        output.installment_schedule = [
            schemas.OrderScheduleOut.model_validate(item) for item in schedules
        ]
    attachment_refs = [("order", order.order_no)]
    attachment_refs.extend(("order_event", event.event_no) for event in events)
    if installment is not None:
        attachment_refs.append(("installment", installment.inst_no))
    if user.has(PERM_FINANCE_READ):
        attachment_refs.extend(("cashflow", item.flow_no) for item in cashflows)
    if attachment_refs:
        output.attachments = [
            schemas.AttachmentOut.model_validate(item)
            for item in db.scalars(
                select(Attachment)
                .where(
                    Attachment.deleted_at.is_(None),
                    or_(*(
                        (Attachment.entity_type == entity_type)
                        & (Attachment.entity_id == entity_id)
                        for entity_type, entity_id in attachment_refs
                    )),
                )
                .order_by(Attachment.created_at, Attachment.id)
            ).all()
        ]
    if user.has(PERM_AUDIT_READ):
        audit_rows = db.scalars(
            select(AuditLog)
            .where(
                AuditLog.entity_type == "order",
                AuditLog.entity_id == order.order_no,
            )
            .order_by(AuditLog.id)
        ).all()
        output.audit = [
            schemas.OrderAuditOut.model_validate(
                {
                    "id": item.id,
                    "action": item.action,
                    "entity_type": item.entity_type,
                    "entity_id": item.entity_id,
                    "actor": item.actor,
                    "reason": item.reason,
                    "request_id": item.request_id,
                    "occurred_at": item.occurred_at,
                }
            )
            for item in audit_rows
        ]
    return output


def _order_list_payload(db: Session, orders: list) -> list[dict]:
    """组装工作台摘要，避免列表页为每一行再请求详情。"""
    # 表单字段自定义值落订单 form_extra 列，列表直接从行数据回显。
    extra_values = {
        item.id: dict(item.form_extra or {}) for item in orders
    }
    order_ids = [item.id for item in orders]
    account_ids = [item.account_id for item in orders if item.account_id is not None]
    accounts = (
        {item.id: item for item in db.scalars(select(Account).where(Account.id.in_(account_ids))).all()}
        if account_ids else {}
    )

    parties: dict[int, tuple[str, str, str | None, str, datetime]] = {}
    if order_ids:
        for role, customer in db.execute(
            select(OrderCustomerRole, Customer)
            .join(Customer, Customer.id == OrderCustomerRole.customer_id)
            .where(OrderCustomerRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(role.order_id, (customer.display_name, role.role, customer.source, customer.created_by, customer.created_at))
        for role, counterparty in db.execute(
            select(OrderCounterpartyRole, Counterparty)
            .join(Counterparty, Counterparty.id == OrderCounterpartyRole.counterparty_id)
            .where(OrderCounterpartyRole.order_id.in_(order_ids))
        ).all():
            parties.setdefault(role.order_id, (counterparty.display_name, role.role, counterparty.source, counterparty.created_by, counterparty.created_at))

    events_by_order: dict[int, list[OrderEvent]] = {}
    if order_ids:
        for event in db.scalars(
            select(OrderEvent)
            .where(OrderEvent.order_id.in_(order_ids), OrderEvent.is_posted.is_(True))
            .order_by(OrderEvent.occurred_on.desc(), OrderEvent.id.desc())
        ).all():
            events_by_order.setdefault(event.order_id, []).append(event)

    installments = (
        {item.order_id: item for item in db.scalars(select(Installment).where(Installment.order_id.in_(order_ids))).all()}
        if order_ids else {}
    )

    payloads: list[dict] = []
    for order in orders:
        account = accounts.get(order.account_id)
        snapshot = order.account_snapshot or {}
        events = events_by_order.get(order.id, [])
        installment = installments.get(order.id)
        latest = events[0] if events else None
        party = parties.get(order.id)
        payloads.append({
            "id": order.id,
            "order_no": order.order_no,
            "order_type": order.order_type,
            "capital_type": order.capital_type,
            "trade_date": order.trade_date,
            "account_id": order.account_id,
            "status": order.status,
            "link_status": order.link_status,
            "owner_id": order.owner_id,
            "note": order.note,
            "extra_values": extra_values.get(order.id, {}),
            "created_at": order.created_at,
            # DFQ 使用订单文本快照；HS / TH / DG 从库存实体展示安全的业务字段，
            # 不把快照中的 game_password 原样带入列表响应。
            "account_game_type": (account.game_type if account else None) or snapshot.get("game_type"),
            "account_game_account": (account.game_account if account else None) or snapshot.get("game_account"),
            "account_channel_region": (account.channel_region if account else None) or snapshot.get("channel_region"),
            "account_business_mode": account.business_mode if account else None,
            "account_platform": account.platform if account else snapshot.get("platform"),
            "account_status": account.status if account else None,
            "party_name": party[0] if party else None,
            "party_role": party[1] if party else None,
            "party_source": party[2] if party else None,
            "party_created_by": party[3] if party else None,
            "party_created_at": party[4] if party else None,
            "event_total": sum((event.amount for event in events), 0),
            "last_event_type": latest.event_type if latest else None,
            "last_event_amount": latest.amount if latest else None,
            "last_event_on": latest.occurred_on if latest else None,
            "installment_principal": installment.principal if installment else None,
            "installment_paid": installment.paid_amount if installment else None,
            "installment_periods": installment.periods if installment else None,
            "installment_status": installment.status if installment else None,
        })
    return payloads


@router.get("/orders", response_model=list[schemas.OrderListOut])
def list_orders(
    order_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    trade_date_from: date | None = Query(default=None),
    trade_date_to: date | None = Query(default=None),
    owner_id: int | None = Query(default=None, gt=0),
    pool_id: int | None = Query(default=None, gt=0),
    keyword: str | None = Query(default=None, max_length=128),
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
        limit=limit,
        offset=offset,
        user=_user,
    )
    return [schemas.OrderListOut.model_validate(item) for item in _order_list_payload(db, orders)]


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
        raise Validation("TH/DFQ 分期订单必须同时提交初始买入和分期合约")
    if payload.initial_buy is not None and payload.installment is None and normalized_order_type == "DFQ":
        raise Validation("初始买入和分期合约必须同时提交")
    expected_contract_type = {
        "DFQ": "ADVANCE_PURCHASE",
        "TH": "PICKUP_SALE",
        "DG": "CONSIGNMENT_SALE",
    }.get(normalized_order_type)
    if payload.installment is not None and payload.installment.contract_type != expected_contract_type:
        raise Validation(
            f"{normalized_order_type} 订单必须使用 {expected_contract_type} 分期合约",
            details={"contract_type": payload.installment.contract_type},
        )
    if payload.initial_buy is not None and normalized_order_type not in {"DFQ", "HS", "TH"}:
        raise Validation("只有 DFQ、HS 或 TH 订单可以在创建时提交初始买入")
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
        game_type=payload.game_type,
        game_account=payload.game_account,
        game_password=payload.game_password,
        channel_region=payload.channel_region,
        bound_phone=payload.bound_phone,
        has_secondary=payload.has_secondary,
        account_note=payload.account_note,
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
        portion=payload.portion,
        delivery_mode=payload.delivery_mode,
        offset_event_id=payload.offset_event_id,
        reason=payload.reason,
        refund_responsibility=payload.refund_responsibility,
        flow_category=payload.flow_category,
        note=payload.note,
        form_extra=payload.form_extra,
        user=user,
    )
    return schemas.EventPostResult(
        event=_event_output(event),
        cashflow_no=flow.flow_no if flow else None,
    )


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


manage_form_fields = require_permissions(PERM_FIELD_DEFINITION_MANAGE)


@router.get(
    "/order-form-fields/scopes",
    response_model=list[schemas.FormScopeOut],
)
def list_form_scopes(
    _user: CurrentUser = manage_form_fields,
) -> list[schemas.FormScopeOut]:
    """表单作用域注册表：设置页「表单」下拉的单一事实源。"""
    from app.orders.form_scopes import list_scopes

    return [schemas.FormScopeOut.model_validate(item) for item in list_scopes()]


@router.get(
    "/order-form-fields",
    response_model=list[schemas.OrderFormFieldOut],
)
def list_order_form_fields(
    order_type_code: str,
    include_inactive: bool = True,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> list[schemas.OrderFormFieldOut]:
    """按业务类型 code 列出建单表单字段配置（含停用项）。"""
    from app.orders import form_fields as ff

    return [
        schemas.OrderFormFieldOut.model_validate(f)
        for f in ff.list_order_form_fields(
            db, order_type_code=order_type_code, include_inactive=include_inactive
        )
    ]


@router.post(
    "/order-form-fields",
    response_model=schemas.OrderFormFieldOut,
    status_code=201,
)
def create_order_form_field(
    payload: schemas.OrderFormFieldCreate,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> schemas.OrderFormFieldOut:
    """新增自定义建单表单字段。"""
    from app.orders import form_fields as ff

    return schemas.OrderFormFieldOut.model_validate(
        ff.create_order_form_field(
            db,
            order_type_code=payload.order_type_code,
            field_key=payload.field_key,
            label=payload.label,
            actor=_user.username,
            field_type=payload.field_type,
            options=payload.options,
            required=payload.required,
            required_when=(
                payload.required_when.model_dump() if payload.required_when is not None else None
            ),
            is_active=payload.is_active,
            sort_order=payload.sort_order,
            note=payload.note,
        )
    )


@router.patch(
    "/order-form-fields/{field_id}",
    response_model=schemas.OrderFormFieldOut,
)
def update_order_form_field(
    field_id: int,
    payload: schemas.OrderFormFieldUpdate,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> schemas.OrderFormFieldOut:
    """编辑建单表单字段（label/类型/选项/必填态/排序/备注）。"""
    from app.orders import form_fields as ff

    extra: dict[str, object] = {}
    # required_when 三态：未传=保持不变；显式 null=清除条件；对象=设为条件必填。
    if "required_when" in payload.model_fields_set:
        extra["required_when"] = (
            payload.required_when.model_dump() if payload.required_when is not None else None
        )

    return schemas.OrderFormFieldOut.model_validate(
        ff.update_order_form_field(
            db,
            field_id,
            actor=_user.username,
            label=payload.label,
            field_type=payload.field_type,
            options=payload.options,
            required=payload.required,
            sort_order=payload.sort_order,
            note=payload.note,
            **extra,
        )
    )


@router.patch(
    "/order-form-fields/{field_id}/active",
    response_model=schemas.OrderFormFieldOut,
)
def set_order_form_field_active(
    field_id: int,
    active: bool,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> schemas.OrderFormFieldOut:
    """启用/停用建单表单字段（核心字段亦允许，由前端提示风险）。"""
    from app.orders import form_fields as ff

    return schemas.OrderFormFieldOut.model_validate(
        ff.set_order_form_field_active(db, field_id, active, actor=_user.username)
    )


@router.delete(
    "/order-form-fields/{field_id}",
    status_code=204,
    response_model=None,
)
def delete_order_form_field(
    field_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> None:
    """删除建单表单字段：核心字段(locked)禁止删除。"""
    from app.orders import form_fields as ff

    ff.delete_order_form_field(db, field_id, actor=_user.username)


__all__ = ["router"]
