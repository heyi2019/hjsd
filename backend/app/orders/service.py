"""orders 订单服务门面：订单建档、查询、更新与资金池汇总。

事件过账与账号状态派生位于 ``orders.events``，通过本模块继续对外提供原入口。

不可突破的口径：
- 订单汇总、账号成本、分期已收一律**由事件派生**，禁止直接写（ORD-02-02）；
- 一个事件最多派生一条有效现金流；`DELIVER` 无金额、无现金流；
- 资金池优先级：事件显式池 > 业务默认路由 > 阻断 `POOL_ROUTE_MISSING`（ORD-02-04）。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from pydantic import ValidationError as PydanticValidationError

from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, owner_scope_filter, owner_scope_ids
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.state_machine import ACCOUNT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.policy import service as policy_service
from app.accounts import service as accounts_service
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    CashflowStatus,
    CounterpartyRole,
    CustomerRole,
    Direction,
    BusinessMode,
    InventoryType,
    Nature,
    OrderLinkType,
    OrderStatus,
    PolicyType,
    Portion,
    PoolStatus,
    SequenceKey,
)
from app.domain.foundation import Pool
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent, OrderLink
from app.domain.users import User
from app.foundation import service as foundation_service
from app.parties import service as parties_service
from app.orders.schemas import OrderAccountCreate, OrderAccountSnapshot

_UNSET = object()


from ._common import _non_negative_money, _positive_money, _required_bool, _required_text



def _audit_value(value: Any) -> Any:
    """把订单快照转换为 JSON 可持久化的值。"""
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {key: _audit_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_audit_value(item) for item in value]
    return value


def _validate_existing_account_context(order_type: str, account: Account) -> None:
    """已建档账号必须带完整业务上下文，并只能挂到对应业务。"""
    expected = {
        "HS": (BusinessMode.SELF.value, InventoryType.RECOVERY.value),
        "DG": (BusinessMode.DISTRIBUTION.value, InventoryType.CONSIGNMENT.value),
    }.get(order_type)
    if expected is None:
        return
    expected_mode, expected_inventory = expected
    if (
        account.business_mode != expected_mode
    ) or (
        account.inventory_type != expected_inventory
    ):
        raise Validation(
            "库存账号业务类型与订单类型不匹配",
            details={
                "order_type": order_type,
                "account_id": account.id,
                "business_mode": account.business_mode,
                "inventory_type": account.inventory_type,
                "expected_business_mode": expected_mode,
                "expected_inventory_type": expected_inventory,
            },
        )


def _normalize_account_data(
    value: dict[str, Any], *, field: str, message: str
) -> dict[str, Any]:
    try:
        return OrderAccountCreate.model_validate(value).model_dump(exclude_none=True)
    except PydanticValidationError as exc:
        raise Validation(
            message,
            details={
                "field": field,
                "errors": [
                    {
                        "field": ".".join(str(part) for part in error["loc"]),
                        "message": error["msg"],
                    }
                    for error in exc.errors()
                ],
            },
        ) from exc


def _normalize_account_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    try:
        return OrderAccountSnapshot.model_validate(snapshot).model_dump(exclude_none=True)
    except PydanticValidationError as exc:
        raise Validation(
            "订单账号快照字段校验失败",
            details={
                "field": "account_snapshot",
                "errors": [
                    {
                        "field": ".".join(str(part) for part in error["loc"]),
                        "message": error["msg"],
                    }
                    for error in exc.errors()
                ],
            },
        ) from exc


def _normalize_account_profile(profile: dict[str, Any]) -> dict[str, Any]:
    return _normalize_account_data(
        profile,
        field="account_profile",
        message="订单账号资料字段校验失败",
    )

_CUSTOMER_ROLES_BY_ORDER_TYPE: dict[str, frozenset[str]] = {
    "HS": frozenset({"SELLER", "BUYER", "INSTALLMENT_CUSTOMER"}),
    "TH": frozenset({"BUYER"}),
    "DG": frozenset({"CONSIGNOR"}),
    "DFQ": frozenset({"INSTALLMENT_CUSTOMER"}),
}
_COUNTERPARTY_ROLES_BY_ORDER_TYPE: dict[str, frozenset[str]] = {
    "HS": frozenset(),
    "TH": frozenset({"PEER"}),
    "DG": frozenset({"PLATFORM"}),
    "DFQ": frozenset({"SUPPLIER"}),
}


def _validate_participant_roles(
    order_type: str,
    customer_roles: Sequence[tuple[int, str]],
    counterparty_roles: Sequence[tuple[int, str]],
) -> None:
    customer_seen: set[tuple[int, str]] = set()
    for _participant_id, role in customer_roles:
        if role not in CustomerRole.values():
            raise Validation(
                f"客户角色必须为 {CustomerRole.values()}",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"role": role},
            )
        allowed_roles = _CUSTOMER_ROLES_BY_ORDER_TYPE.get(order_type)
        if allowed_roles is not None and role not in allowed_roles:
            raise Validation(
                f"{order_type} 不允许客户角色 {role}",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"order_type": order_type, "role": role},
            )
        if isinstance(_participant_id, bool) or not isinstance(_participant_id, int) or _participant_id <= 0:
            raise Validation(
                "客户参与方 ID 必须为正整数",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"customer_id": _participant_id, "role": role},
            )
        key = (_participant_id, role)
        if key in customer_seen:
            raise Validation(
                "同一客户同一角色不可重复",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"customer_id": key[0], "role": role},
            )
        customer_seen.add(key)
    counterparty_seen: set[tuple[int, str]] = set()
    for _participant_id, role in counterparty_roles:
        if role not in CounterpartyRole.values():
            raise Validation(
                f"合作方角色必须为 {CounterpartyRole.values()}",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"role": role},
            )
        allowed_roles = _COUNTERPARTY_ROLES_BY_ORDER_TYPE.get(order_type)
        if allowed_roles is not None and role not in allowed_roles:
            raise Validation(
                f"{order_type} 不允许合作方角色 {role}",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"order_type": order_type, "role": role},
            )
        if isinstance(_participant_id, bool) or not isinstance(_participant_id, int) or _participant_id <= 0:
            raise Validation(
                "合作方参与方 ID 必须为正整数",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"counterparty_id": _participant_id, "role": role},
            )
        key = (_participant_id, role)
        if key in counterparty_seen:
            raise Validation(
                "同一合作方同一角色不可重复",
                code=ErrorCode.PARTICIPANT_ROLE_INVALID,
                details={"counterparty_id": key[0], "role": role},
            )
        counterparty_seen.add(key)


# --------------------------------------------------------------------- 订单
def create_order(
    session: Session,
    *,
    order_type: str,
    trade_date: date,
    listing_price: Any = None,
    service_fee: Any = None,
    commission_mode: str | None = None,
    commission_payer: str | None = None,
    expected_settlement_date: date | None = None,
    account_snapshot: dict[str, Any] | None = None,
    actor: str,
    account_id: int | None = None,
    account_profile: dict[str, Any] | None = None,
    owner_id: int | None = None,
    capital_type: str | None = None,
    note: str | None = None,
    customer_roles: Sequence[tuple[int, str]] = (),
    counterparty_roles: Sequence[tuple[int, str]] = (),
    extra_values: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Order:
    definition = foundation_service.get_order_type_by_code(session, order_type)
    if definition is None:
        raise Validation(
            f"业务类型 {order_type} 不存在", details={"order_type": order_type}
        )
    if not definition.is_active:
        raise Validation(
            f"业务类型 {order_type} 已停用，禁止新建单",
            code=ErrorCode.ORDER_TYPE_DISABLED,
            details={"order_type": order_type},
        )
    if definition.code in {"DFQ", "TH"} and (
        account_id is not None or account_profile is not None
    ):
        raise Validation(
            "提号订单不关联库存账号" if definition.code == "TH" else "DFQ 代分期订单不关联库存账号",
            details={"order_type": definition.code, "account_id": account_id},
        )
    if definition.code not in {"DFQ", "TH"} and account_snapshot is not None:
        raise Validation("只有 DFQ 代分期和 TH 提号订单可以填写订单账号快照")
    if account_snapshot is not None:
        account_snapshot = _normalize_account_snapshot(account_snapshot)
    if account_profile is not None:
        account_profile = _normalize_account_profile(account_profile)
    selected_capital_type = (
        definition.capital_type if capital_type is None else capital_type
    )
    if selected_capital_type not in CapitalType.values():
        raise Validation(
            f"capital_type 必须为 {CapitalType.values()}",
            details={"field": "capital_type", "value": selected_capital_type},
        )
    listing_amount = (
        _non_negative_money(listing_price, field="listing_price")
        if listing_price is not None
        else None
    )
    service_fee_amount = (
        _non_negative_money(service_fee, field="service_fee")
        if service_fee is not None
        else None
    )
    if definition.code != "DG" and any(
        value is not None
        for value in (
            listing_amount,
            service_fee_amount,
            commission_mode,
            commission_payer,
            expected_settlement_date,
        )
    ):
        raise Validation("只有 DG 代挂订单可以填写代挂结算条款")
    if definition.code == "DG":
        if commission_mode is not None and (
            not isinstance(commission_mode, str)
            or commission_mode not in {
                "DEDUCT_FROM_SETTLEMENT",
                "SEPARATE_PAYMENT",
            }
        ):
            raise Validation("代挂抽成方式无效", details={"field": "commission_mode"})
        if commission_payer is not None and (
            not isinstance(commission_payer, str)
            or commission_payer not in {
                "BUYER",
                "CONSIGNOR",
                "PLATFORM",
            }
        ):
            raise Validation("代挂付款方无效", details={"field": "commission_payer"})
        if (commission_mode is None) != (commission_payer is None):
            raise Validation("代挂抽成方式和付款方必须同时填写")
        if (
            listing_amount is not None
            and service_fee_amount is not None
            and service_fee_amount > listing_amount
        ):
            raise Validation("服务费不能超过挂售价")
    if account_id is not None and account_profile is not None:
        raise Validation(
            "订单不能同时关联已有库存账号和新建账号资料",
            details={"order_type": definition.code},
        )
    if account_id is not None:
        account = accounts_service.get_account(session, account_id, user)
        _validate_existing_account_context(definition.code, account)

    _validate_participant_roles(
        definition.code, customer_roles, counterparty_roles
    )
    customer_participants = [
        (
            customer_id,
            role,
            parties_service.assert_customer_usable(session, customer_id, user=user),
        )
        for customer_id, role in customer_roles
    ]
    counterparty_participants = [
        (
            counterparty_id,
            role,
            parties_service.assert_counterparty_usable(
                session, counterparty_id, expected_type=role
            ),
        )
        for counterparty_id, role in counterparty_roles
    ]

    if user is not None and not user.is_admin and user.owner_scope != "ALL":
        owner_id = user.id
    if owner_id is not None:
        if isinstance(owner_id, bool) or not isinstance(owner_id, int) or owner_id <= 0:
            raise Validation(
                "订单负责人 ID 必须为正整数", details={"field": "owner_id", "value": owner_id}
            )
        owner = session.get(User, owner_id)
        if owner is None:
            raise Validation(
                "订单负责人不存在", details={"field": "owner_id", "owner_id": owner_id}
            )
        if not owner.is_active:
            raise Validation(
                "订单负责人必须是启用用户",
                details={"field": "owner_id", "owner_id": owner_id},
            )

    if account_profile is not None:
        inventory_context = {
            "HS": ("SELF", "RECOVERY"),
            "DG": ("DISTRIBUTION", "CONSIGNMENT"),
        }.get(definition.code)
        if inventory_context is None:
            raise Validation(
                f"业务 {definition.code} 不允许随订单建档库存账号",
                details={"order_type": definition.code},
            )
        account = accounts_service.create_account(
            session,
            actor=actor,
            business_mode=inventory_context[0],
            inventory_type=inventory_context[1],
            **account_profile,
        )
        account_id = account.id


    # BAS-06-04 规则快照：按成交日固化当时生效的返点/提成规则。
    # 规则改版不回写这里，历史订单永远按当时口径计算。
    snapshot: dict[str, Any] = {}
    primary_version_id: int | None = None
    for code in (PolicyType.REBATE.value, PolicyType.COMMISSION.value):
        version_id, snap = policy_service.make_snapshot(
            session,
            policy_code=code,
            on=trade_date,
            scope_type="ORDER_TYPE",
            scope_id=definition.id,
        )
        if snap is None:
            continue
        snapshot[code] = snap
        # policy_version_id 只存一个主版本（返点优先），完整参数在 policy_snapshot 里
        if primary_version_id is None:
            primary_version_id = version_id

    order = Order(
        order_no=foundation_service.next_order_no(session, definition),
        order_type=definition.code,
        capital_type=selected_capital_type,
        trade_date=trade_date,
        listing_price=listing_amount,
        service_fee=service_fee_amount,
        commission_mode=commission_mode,
        commission_payer=commission_payer,
        expected_settlement_date=expected_settlement_date,
        account_snapshot=account_snapshot,
        account_id=account_id,
        status=OrderStatus.ACTIVE.value,
        policy_version_id=primary_version_id,
        policy_snapshot=snapshot or None,
        owner_id=owner_id,
        note=note,
        created_by=actor,
        updated_by=actor,
    )
    session.add(order)
    session.flush()

    role_records: list[dict[str, Any]] = []
    for customer_id, role, customer in customer_participants:
        role_records.append({"kind": "customer", "id": customer.customer_no, "role": role})
        session.add(
            _customer_role(order.id, customer_id, role)
        )
    for counterparty_id, role, counterparty in counterparty_participants:
        role_records.append(
            {"kind": "counterparty", "id": counterparty.counterparty_no, "role": role}
        )
        session.add(_counterparty_role(order.id, counterparty_id, role))
    session.flush()
    parties_service.set_extra_values(
        session,
        entity_type="order",
        entity_id=order.id,
        values=(extra_values or {}).items(),
        require_all=True,
    )

    record_audit(
        session,
        action=AuditAction.ORDER_CREATE,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        after={"order_type": order.order_type, "status": order.status, "roles": role_records},
    )
    return order


def _customer_role(order_id: int, customer_id: int, role: str):
    from app.domain.parties import OrderCustomerRole

    return OrderCustomerRole(order_id=order_id, customer_id=customer_id, role=role)


def _counterparty_role(order_id: int, counterparty_id: int, role: str):
    from app.domain.parties import OrderCounterpartyRole

    return OrderCounterpartyRole(
        order_id=order_id, counterparty_id=counterparty_id, role=role
    )


def get_order(session: Session, order_id: int, user: CurrentUser | None = None) -> Order:
    order = session.get(Order, order_id)
    if order is None:
        raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if order.owner_id not in (visible_ids or set()):
            raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    return order


def create_order_link(
    session: Session,
    order_id: int,
    *,
    related_order_id: int,
    relation_type: str,
    split_ratio: Any = None,
    split_amount: Any = None,
    note: str | None = None,
    actor: str,
    user: CurrentUser | None = None,
) -> OrderLink:
    """建立上下游订单关系；拆分口径作为关系快照保存，不改写订单金额。"""
    relation = relation_type.strip().upper() if isinstance(relation_type, str) else relation_type
    if relation not in OrderLinkType.values():
        raise Validation(
            "关联方向无效",
            details={"field": "relation_type", "allowed": list(OrderLinkType.values())},
        )
    order = get_order(session, order_id, user)
    related = get_order(session, related_order_id, user)
    if order.id == related.id:
        raise Validation("订单不能关联自身", details={"order_id": order.id})
    source_id, target_id = (
        (related.id, order.id)
        if relation == OrderLinkType.SOURCE.value
        else (order.id, related.id)
    )
    existing = session.scalar(
        select(OrderLink).where(
            OrderLink.source_order_id == source_id,
            OrderLink.target_order_id == target_id,
        )
    )
    if existing is not None:
        raise Validation(
            "订单关联已存在",
            details={"source_order_id": source_id, "target_order_id": target_id},
        )
    ratio = None if split_ratio is None else _positive_money(split_ratio, field="split_ratio")
    if ratio is not None and ratio > Decimal("100"):
        raise Validation("拆分比例不能超过 100%", details={"field": "split_ratio"})
    amount = None if split_amount is None else _positive_money(split_amount, field="split_amount")
    link = OrderLink(
        source_order_id=source_id,
        target_order_id=target_id,
        relation_type=relation,
        split_ratio=ratio,
        split_amount=amount,
        note=note.strip() if isinstance(note, str) and note.strip() else None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(link)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_LINK_CREATE,
        entity_type="order_link",
        entity_id=link.id,
        actor=actor,
        after={
            "source_order_id": source_id,
            "target_order_id": target_id,
            "relation_type": relation,
            "split_ratio": str(ratio) if ratio is not None else None,
            "split_amount": str(amount) if amount is not None else None,
        },
    )
    return link


def list_order_links(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    """按当前订单视角返回来源单与后续单。"""
    order = get_order(session, order_id, user)
    rows = session.scalars(
        select(OrderLink)
        .where(
            or_(
                OrderLink.source_order_id == order.id,
                OrderLink.target_order_id == order.id,
            )
        )
        .order_by(OrderLink.id)
    ).all()
    order_ids = {
        item_id
        for row in rows
        for item_id in (row.source_order_id, row.target_order_id)
    }
    orders = {
        item.id: item
        for item in session.scalars(select(Order).where(Order.id.in_(order_ids))).all()
    } if order_ids else {}
    result: list[dict[str, Any]] = []
    for row in rows:
        direction = (
            OrderLinkType.FOLLOW_UP.value
            if row.source_order_id == order.id
            else OrderLinkType.SOURCE.value
        )
        result.append(
            {
                "id": row.id,
                "source_order_id": row.source_order_id,
                "source_order_no": orders[row.source_order_id].order_no,
                "target_order_id": row.target_order_id,
                "target_order_no": orders[row.target_order_id].order_no,
                "relation_type": row.relation_type,
                "direction": direction,
                "split_ratio": row.split_ratio,
                "split_amount": row.split_amount,
                "note": row.note,
                "created_at": row.created_at,
            }
        )
    return result


def list_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    user: CurrentUser | None = None,
) -> list[Order]:
    stmt = select(Order)
    if order_type:
        stmt = stmt.where(Order.order_type == order_type)
    if status:
        stmt = stmt.where(Order.status == status)
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(session.scalars(stmt.order_by(Order.id)).all())


def update_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    trade_date: date | None | object = _UNSET,
    listing_price: Any = _UNSET,
    service_fee: Any = _UNSET,
    commission_mode: str | None | object = _UNSET,
    commission_payer: str | None | object = _UNSET,
    expected_settlement_date: date | None | object = _UNSET,
    account_snapshot: dict[str, Any] | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Order:
    """受控编辑订单主字段。

    订单一旦存在已过账事件，核算字段只能通过事件冲销/更正处理；备注仍可补充。
    订单编号、业务类型、库存账号关联和状态属于不可编辑的身份字段。
    """
    order = get_order(session, order_id, user)
    if trade_date is not _UNSET and trade_date is None:
        raise Validation("订单日期不能清空", details={"field": "trade_date"})
    accounting_changes = (
        trade_date,
        listing_price,
        service_fee,
        commission_mode,
        commission_payer,
        expected_settlement_date,
        account_snapshot,
    )
    if any(value is not _UNSET for value in accounting_changes):
        posted = session.scalar(
            select(OrderEvent.id).where(
                OrderEvent.order_id == order.id,
                OrderEvent.is_posted.is_(True),
            )
        )
        if posted is not None:
            raise Validation("已有过账事件的订单只能修改备注，核算字段必须通过冲销/更正")

    next_listing = (
        _non_negative_money(listing_price, field="listing_price")
        if listing_price is not _UNSET and listing_price is not None
        else (None if listing_price is None else order.listing_price)
    )
    next_service_fee = (
        _non_negative_money(service_fee, field="service_fee")
        if service_fee is not _UNSET and service_fee is not None
        else (None if service_fee is None else order.service_fee)
    )
    next_mode = order.commission_mode if commission_mode is _UNSET else commission_mode
    next_payer = order.commission_payer if commission_payer is _UNSET else commission_payer

    if order.order_type != "DG" and any(
        value is not _UNSET and value is not None
        for value in (
            listing_price,
            service_fee,
            commission_mode,
            commission_payer,
            expected_settlement_date,
        )
    ):
        raise Validation("只有 DG 代挂订单可以填写代挂结算条款")
    if order.order_type == "DG":
        if next_mode is not None and (
            not isinstance(next_mode, str)
            or next_mode not in {
                "DEDUCT_FROM_SETTLEMENT",
                "SEPARATE_PAYMENT",
            }
        ):
            raise Validation("代挂抽成方式无效", details={"field": "commission_mode"})
        if next_payer is not None and (
            not isinstance(next_payer, str)
            or next_payer not in {
                "BUYER",
                "CONSIGNOR",
                "PLATFORM",
            }
        ):
            raise Validation("代挂付款方无效", details={"field": "commission_payer"})
        if (next_mode is None) != (next_payer is None):
            raise Validation("代挂抽成方式和付款方必须同时填写")
        if (
            next_listing is not None
            and next_service_fee is not None
            and next_service_fee > next_listing
        ):
            raise Validation("服务费不能超过挂售价")
    if account_snapshot is not _UNSET and account_snapshot is not None:
        if order.order_type not in {"DFQ", "TH"}:
            raise Validation("只有 DFQ 代分期和 TH 提号订单可以填写订单账号快照")
        account_snapshot = _normalize_account_snapshot(account_snapshot)

    before = {
        "trade_date": order.trade_date,
        "listing_price": order.listing_price,
        "service_fee": order.service_fee,
        "commission_mode": order.commission_mode,
        "commission_payer": order.commission_payer,
        "expected_settlement_date": order.expected_settlement_date,
        "account_snapshot": order.account_snapshot,
        "note": order.note,
    }
    if trade_date is not _UNSET:
        order.trade_date = trade_date
    if listing_price is not _UNSET:
        order.listing_price = next_listing
    if service_fee is not _UNSET:
        order.service_fee = next_service_fee
    if commission_mode is not _UNSET:
        order.commission_mode = commission_mode
    if commission_payer is not _UNSET:
        order.commission_payer = commission_payer
    if expected_settlement_date is not _UNSET:
        order.expected_settlement_date = expected_settlement_date
    if account_snapshot is not _UNSET:
        order.account_snapshot = account_snapshot
    if note is not _UNSET:
        order.note = note
    order.updated_by = actor
    session.flush()
    if extra_values is not _UNSET:
        parties_service.set_extra_values(
            session,
            entity_type="order",
            entity_id=order.id,
            values=(extra_values or {}).items(),
        )
    record_audit(
        session,
        action=AuditAction.ORDER_UPDATE,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        before=_audit_value(before),
        after=_audit_value({
            "trade_date": order.trade_date,
            "listing_price": order.listing_price,
            "service_fee": order.service_fee,
            "commission_mode": order.commission_mode,
            "commission_payer": order.commission_payer,
            "expected_settlement_date": order.expected_settlement_date,
            "account_snapshot": order.account_snapshot,
            "note": order.note,
        }),
    )
    return order


def cancel_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> Order:
    """作废尚未过账的订单；已产生业务事实的订单必须走事件冲销。"""
    reason = _required_text(reason, field="reason", message="订单作废必须填写原因")
    order = get_order(session, order_id, user)
    posted = session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.is_posted.is_(True),
        )
    )
    if posted is not None:
        raise Validation("订单已有过账事件，不能直接作废，请先冲销")
    order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单")
    order.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_CANCEL,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        after={"status": order.status},
        reason=reason.strip(),
    )
    return order


from .events import _apply_account_effect, _opposite_direction, post_event



# --------------------------------------------------------------------- 池余额
def pool_balance(
    session: Session, pool_id: int, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金池卡片：经营收支、内部划转、押金占用与可用余额。"""
    pool = session.get(Pool, pool_id)
    if pool is None or (user is not None and not user.can_see_pool(pool_id)):
        raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})

    def total(direction: str, nature: str | None = None) -> Decimal:
        stmt = select(func.coalesce(func.sum(Cashflow.amount), 0)).where(
            Cashflow.pool_id == pool_id,
            Cashflow.direction == direction,
            Cashflow.status == CashflowStatus.APPROVED.value,
        )
        if nature:
            stmt = stmt.where(Cashflow.nature == nature)
        return to_money(session.scalar(stmt) or 0)

    income = total(Direction.IN.value, Nature.BUSINESS_IN.value)
    expense = total(Direction.OUT.value, Nature.BUSINESS_OUT.value)
    transfer_in = total(Direction.IN.value, Nature.INTERNAL.value)
    transfer_out = total(Direction.OUT.value, Nature.INTERNAL.value)
    # 现金头寸包含 INTERNAL 划转；经营收入/支出仍只统计 BUSINESS_*，避免把划转算进损益。
    cash_balance = total(Direction.IN.value) - total(Direction.OUT.value)

    deposit_held = _deposit_held(session, pool_id)
    return {
        "pool_id": pool.id,
        "pool_code": pool.code,
        "income": income,
        "expense": expense,
        "transfer_in": transfer_in,
        "transfer_out": transfer_out,
        "cash_balance": cash_balance,
        "deposit_held": deposit_held,
        "available": cash_balance - deposit_held,
    }


def _deposit_held(session: Session, pool_id: int) -> Decimal:
    from app.domain.trade import Deposit

    stmt = select(
        func.coalesce(
            func.sum(Deposit.paid_amount - Deposit.returned_amount - Deposit.lost_amount),
            0,
        )
    ).where(Deposit.pool_id == pool_id)
    return to_money(session.scalar(stmt) or 0)


__all__ = [
    "cancel_order",
    "create_order_link",
    "create_order",
    "get_order",
    "list_orders",
    "list_order_links",
    "pool_balance",
    "post_event",
    "update_order",
]
