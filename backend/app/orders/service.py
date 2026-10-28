"""orders 订单服务门面：订单建档、查询、更新与资金池汇总。

事件登记与账号状态派生位于 ``orders.events``，通过本模块继续对外提供原入口。

不可突破的口径：
- 订单汇总、账号成本、分期已收一律**由事件派生**，禁止直接写（ORD-02-02）；
- 一个事件最多派生一条有效现金流；`DELIVER` 无金额、无现金流；
- 资金池优先级：事件显式池 > 业务默认路由 > 阻断 `POOL_ROUTE_MISSING`（ORD-02-04）。
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session
from pydantic import ValidationError as PydanticValidationError
from app.core.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, Validation
from app.core.security import CurrentUser, owner_scope_filter, owner_scope_ids
from app.core.money import to_money
from app.core.numbering import allocate_number
from app.core.state_machine import ACCOUNT_TRANSITIONS, ORDER_TRANSITIONS, transition
from app.policy import service as policy_service
from app.stocks import service as stocks_service
from app.domain.enums import (
    AccountStatus,
    AuditAction,
    CapitalType,
    CashflowStatus,
    CommissionMode,
    CommissionPayer,
    CounterpartyRole,
    CustomerRole,
    Direction,
    BusinessMode,
    InstallmentContractType,
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
from app.domain.trade import Account, Cashflow, Installment, Order, OrderEvent, OrderFormField, OrderLink
from app.domain.users import User
from app.foundation import service as foundation_service
from app.parties import service as parties_service
from app.orders.schemas import OrderAccountSnapshot
from app.orders.form_fields import validate_form_extra, validate_order_form_extra

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
        "TH": (BusinessMode.DISTRIBUTION.value, InventoryType.PICKUP.value),
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
def _create_inline_inventory_account(session: Session, *, order_type: str, game_account: str, actor: str, game_type: str | None, game_password: str | None, channel_region: str | None, bound_phone: str | None, has_secondary: bool | None, account_note: str | None, value_added_service: str | None = None, platform: str | None = None, extra_values: Mapping[str, Any] | None = None) -> Account:
    mode, inventory_type = {
        "HS": ("SELF", "RECOVERY"),
        "TH": ("DISTRIBUTION", "PICKUP"),
        "DG": ("DISTRIBUTION", "CONSIGNMENT"),
        # 代分期（垫资买入）：业务类型留空，以增值服务维度（代分期/分销）标识。
        "DFQ": ("DISTRIBUTION", None),
    }[order_type]
    return stocks_service.create_account(
        session, game_account=game_account, actor=actor, game_type=game_type,
        business_mode=mode, inventory_type=inventory_type, game_password=game_password,
        channel_region=channel_region, bound_phone=bound_phone,
        has_secondary=has_secondary, note=account_note,
        value_added_service=value_added_service, platform=platform,
        extra_values=extra_values,
    )


def _normalize_commission_value(value: str | None, field: str) -> str | None:
    """佣金口径入参归一：空串 / 非字符串一律视作「未填」，其余去空格并大写。

    大写是硬要求——`orders` 上有 CHECK 约束 `order_commission_mode_valid` /
    `order_commission_payer_valid`，小写会被数据库直接拒绝。
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise Validation(
            f"{field} 必须为字符串", details={"field": field, "value": value}
        )
    cleaned = value.strip().upper()
    return cleaned or None


def create_order(
    session: Session,
    *,
    order_type: str,
    trade_date: date,
    account_snapshot: dict[str, Any] | None = None,
    actor: str,
    account_id: int | None = None,
    game_type: str | None = None,
    game_account: str | None = None,
    game_password: str | None = None,
    channel_region: str | None = None,
    bound_phone: str | None = None,
    has_secondary: bool | None = None,
    account_note: str | None = None,
    owner_id: int | None = None,
    capital_type: str | None = None,
    note: str | None = None,
    commission_mode: str | None = None,
    commission_payer: str | None = None,
    customer_roles: Sequence[tuple[int, str]] = (),
    counterparty_roles: Sequence[tuple[int, str]] = (),
    extra_values: Mapping[str, Any] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    form_extra_scope: str | None = None,
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
    # 2026-10-28 口径：account_snapshot 四类业务通用（HS/TH/DG/DFQ），
    # 与平铺账号字段互斥——快照传了就不允许再单独传游戏账号字段。
    if account_snapshot is not None and definition.code not in {"HS", "TH", "DG", "DFQ"}:
        raise Validation(f"业务类型 {definition.code} 不支持订单账号快照")
    if (
        account_snapshot is not None
        and definition.code in {"HS", "TH", "DG"}
        and any(v is not None for v in (game_account, game_type, game_password, channel_region))
    ):
        raise Validation("游戏账号资料请通过 account_snapshot 传递，不要与单独账号字段混用")
    if definition.code == "DFQ" and any(
        v is not None
        for v in (
            game_type,
            game_account,
            game_password,
            channel_region,
            bound_phone,
            has_secondary,
            account_note,
        )
    ):
        raise Validation("DFQ 代分期订单的游戏账号资料应填写在 account_snapshot 内，不应单独传游戏账号字段")
    if account_snapshot is not None:
        account_snapshot = _normalize_account_snapshot(account_snapshot)
    # 账号/产品扩展值以库存账号为事实来源；兼容旧调用方把它放在
    # form_extra 的写法，但落订单前先拆出账号字段，避免订单与库存双写。
    snapshot_extra = dict((account_snapshot or {}).get("extra_values") or {})
    submitted_extra = dict(form_extra or {})
    merged_extra = {**snapshot_extra, **submitted_extra}
    form_extra = validate_form_extra(
        session,
        order_type_code=(form_extra_scope or definition.code),
        values=merged_extra,
    )
    account_field_keys = set(session.scalars(
        select(OrderFormField.field_key).where(
            OrderFormField.order_type_code == definition.code,
            OrderFormField.is_custom.is_(True),
            OrderFormField.is_active.is_(True),
            OrderFormField.section == "ACCOUNT_PRODUCT",
        )
    ).all())
    if account_snapshot is not None:
        account_values = {
            **snapshot_extra,
            **{key: value for key, value in form_extra.items() if key in account_field_keys},
        }
        if account_values:
            account_snapshot["extra_values"] = account_values
        else:
            account_snapshot.pop("extra_values", None)
        form_extra = {
            key: value for key, value in form_extra.items() if key not in account_field_keys
        }
    selected_capital_type = (
        definition.capital_type if capital_type is None else capital_type
    )
    if selected_capital_type not in CapitalType.values():
        raise Validation(
            f"capital_type 必须为 {CapitalType.values()}",
            details={"field": "capital_type", "value": selected_capital_type},
        )
    # 佣金口径：仅 DG 代挂单可用，且支付方式与承担方必须成对出现（DB CHECK 同口径）。
    normalized_commission_mode = _normalize_commission_value(commission_mode, "commission_mode")
    normalized_commission_payer = _normalize_commission_value(commission_payer, "commission_payer")
    if (normalized_commission_mode is None) != (normalized_commission_payer is None):
        raise Validation(
            "佣金支付方式与佣金承担方必须同时填写或同时留空",
            details={
                "commission_mode": normalized_commission_mode,
                "commission_payer": normalized_commission_payer,
            },
        )
    if normalized_commission_mode is not None:
        if definition.code != "DG":
            raise Validation(
                "只有 DG 代挂订单可以填写佣金口径",
                details={"order_type": definition.code},
            )
        if normalized_commission_mode not in CommissionMode.values():
            raise Validation(
                f"commission_mode 必须为 {CommissionMode.values()}",
                details={"field": "commission_mode", "value": normalized_commission_mode},
            )
        if normalized_commission_payer not in CommissionPayer.values():
            raise Validation(
                f"commission_payer 必须为 {CommissionPayer.values()}",
                details={"field": "commission_payer", "value": normalized_commission_payer},
            )
    if account_id is not None:
        account = stocks_service.get_account(session, account_id, user)
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
    # 兜底：admin / ALL 建单未指定负责人时记为操作人本人。否则落 NULL 的单据在
    # 数据权限按 owner_id 过滤（owner_scope_filter）后，对 SELF 用户永久不可见。
    if owner_id is None and user is not None:
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

    # 2026-10-28 去冗余：账号资料单一事实源 = account_snapshot。
    # 旧调用方传平铺字段时自动转为快照（API 契约保留，物理冗余列已删除）。
    if (
        account_snapshot is None
        and definition.code in {"HS", "TH", "DG"}
        and game_account
    ):
        account_snapshot = {
            "game_account": game_account,
            "game_type": game_type,
            "game_password": game_password,
            "channel_region": channel_region,
            "bound_phone": bound_phone,
            "has_secondary": has_secondary,
            "note": account_note,
        }
        account_snapshot = _normalize_account_snapshot(account_snapshot)

    # 2026-10-28 口径：HS/TH/DG 快照建单——快照值展开为局部变量，
    # 供内联建号使用；订单行只落快照，不再写平铺列。
    if account_snapshot is not None and definition.code in {"HS", "TH", "DG"}:
        snap = account_snapshot
        game_account = snap["game_account"]
        game_type = snap.get("game_type")
        game_password = snap.get("game_password")
        channel_region = snap.get("channel_region")
        bound_phone = snap.get("bound_phone")
        has_secondary = snap.get("has_secondary")
        account_note = snap.get("note")

    # 内联建库存账号（2026-10-28 口径）：建单成功即生成库存编号，不再等 BUY 事件。
    # HS/TH 表单的账号资料为必填，game_account 必有值；缺资料时退回 BUY 事件兜底建号。
    if definition.code in {"HS", "TH"} and account_id is None and game_account:
        account_id = _create_inline_inventory_account(
            session, order_type=definition.code, game_account=game_account, actor=actor,
            game_type=game_type, game_password=game_password, channel_region=channel_region,
            bound_phone=bound_phone, has_secondary=has_secondary, account_note=account_note,
            extra_values=(account_snapshot or {}).get("extra_values"),
        ).id

    if definition.code == "DG" and account_id is None and game_account:
        account_id = _create_inline_inventory_account(
            session, order_type=definition.code, game_account=game_account, actor=actor,
            game_type=game_type, game_password=game_password, channel_region=channel_region,
            bound_phone=bound_phone, has_secondary=has_secondary, account_note=account_note,
            extra_values=(account_snapshot or {}).get("extra_values"),
        ).id

    # 代分期垫资买入：账号计入本方库存（业务类型留空，增值服务=分销分期/代分期）。
    if definition.code == "DFQ" and account_id is None and account_snapshot is not None:
        snap = account_snapshot or {}
        account_id = _create_inline_inventory_account(
            session, order_type="DFQ", game_account=snap["game_account"], actor=actor,
            game_type=snap.get("game_type"), game_password=snap.get("game_password"),
            channel_region=snap.get("channel_region"), bound_phone=snap.get("bound_phone"),
            has_secondary=snap.get("has_secondary"), account_note=snap.get("note"),
            value_added_service=InstallmentContractType.ADVANCE_PURCHASE.value,
            platform=snap.get("platform"), extra_values=snap.get("extra_values"),
        ).id

    order = Order(
        order_no=foundation_service.next_order_no(session, definition),
        order_type=definition.code,
        capital_type=selected_capital_type,
        trade_date=trade_date,
        account_snapshot=account_snapshot,
        account_id=account_id,
        status=OrderStatus.ACTIVE.value,
        policy_version_id=primary_version_id,
        policy_snapshot=snapshot or None,
        owner_id=owner_id,
        note=note,
        commission_mode=normalized_commission_mode,
        commission_payer=normalized_commission_payer,
        form_extra=dict(form_extra) if form_extra else None,
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
    form_extra: Mapping[str, Any] | None = None,
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
        form_extra=dict(form_extra) if form_extra else None,
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


def delete_order_link(
    session: Session,
    order_id: int,
    link_id: int,
    *,
    actor: str,
    user: CurrentUser | None = None,
) -> None:
    """删除上下游订单关系；只允许删挂在当前订单上的关联，删后可重新建立。"""
    order = get_order(session, order_id, user)
    link = session.get(OrderLink, link_id)
    if (
        link is None
        or (link.source_order_id != order.id and link.target_order_id != order.id)
    ):
        raise NotFound(f"订单关联 {link_id} 不存在", details={"link_id": link_id})
    before = {
        "source_order_id": link.source_order_id,
        "target_order_id": link.target_order_id,
        "relation_type": link.relation_type,
        "split_ratio": str(link.split_ratio) if link.split_ratio is not None else None,
        "split_amount": str(link.split_amount) if link.split_amount is not None else None,
    }
    session.delete(link)
    session.flush()
    record_audit(
        session,
        action=AuditAction.ORDER_LINK_DELETE,
        entity_type="order_link",
        entity_id=link_id,
        actor=actor,
        before=before,
    )


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
                "form_extra": row.form_extra,
                "created_at": row.created_at,
            }
        )
    return result


def list_orders(
    session: Session, *, order_type: str | None = None, status: str | None = None,
    trade_date_from: date | None = None,
    trade_date_to: date | None = None,
    owner_id: int | None = None,
    pool_id: int | None = None,
    keyword: str | None = None,
    limit: int = 100,
    offset: int = 0,
    user: CurrentUser | None = None,
) -> list[Order]:
    stmt = select(Order).outerjoin(Account, Account.id == Order.account_id)
    if order_type:
        stmt = stmt.where(Order.order_type == order_type)
    if status:
        stmt = stmt.where(Order.status == status)
    if trade_date_from is not None:
        stmt = stmt.where(Order.trade_date >= trade_date_from)
    if trade_date_to is not None:
        stmt = stmt.where(Order.trade_date <= trade_date_to)
    if owner_id is not None:
        stmt = stmt.where(Order.owner_id == owner_id)
    if pool_id is not None:
        stmt = stmt.where(
            exists(
                select(OrderEvent.id).where(
                    OrderEvent.order_id == Order.id,
                    OrderEvent.pool_id == pool_id,
                )
            )
        )
    if keyword and keyword.strip():
        pattern = f"%{keyword.strip()}%"
        stmt = stmt.where(
            or_(
                Order.order_no.ilike(pattern),
                # 2026-10-28 去冗余：平铺列已删，订单侧账号搜索走快照 JSON
                func.json_extract(Order.account_snapshot, "$.game_account").ilike(pattern),
                Account.game_account.ilike(pattern),
                Order.note.ilike(pattern),
            )
        )
    if user is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None:
            stmt = stmt.where(scope)
    return list(
        session.scalars(
            stmt.order_by(Order.id).limit(limit).offset(offset)
        ).unique().all()
    )


def update_order(
    session: Session,
    order_id: int,
    *,
    actor: str,
    trade_date: date | None | object = _UNSET,
    account_snapshot: dict[str, Any] | None | object = _UNSET,
    note: str | None | object = _UNSET,
    extra_values: Mapping[str, Any] | None | object = _UNSET,
    form_extra: Mapping[str, Any] | None | object = _UNSET,
    user: CurrentUser | None = None,
) -> Order:
    """受控编辑订单主字段。

    订单一旦存在已登记事件，核算字段只能通过事件冲销/更正处理；备注仍可补充。
    订单编号、业务类型、库存账号关联和状态属于不可编辑的身份字段。
    """
    order = get_order(session, order_id, user)
    if trade_date is not _UNSET and trade_date is None:
        raise Validation("订单日期不能清空", details={"field": "trade_date"})
    accounting_changes = (
        trade_date,
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
            raise Validation("已有登记事件的订单只能修改备注，核算字段必须通过冲销/更正")

    if account_snapshot is not _UNSET and account_snapshot is not None:
        if order.order_type != "DFQ":
            raise Validation("只有 DFQ 代分期订单可以填写订单账号快照")
        account_snapshot = _normalize_account_snapshot(account_snapshot)

    before = {
        "trade_date": order.trade_date,
        "account_snapshot": order.account_snapshot,
        "note": order.note,
    }
    if trade_date is not _UNSET:
        order.trade_date = trade_date
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
    if form_extra is not _UNSET and form_extra:
        # ORDEREDIT 作用域自定义字段值合并进订单 form_extra。
        checked = validate_form_extra(session, order_type_code="ORDEREDIT", values=form_extra)
        order.form_extra = {**(order.form_extra or {}), **checked}
    record_audit(
        session,
        action=AuditAction.ORDER_UPDATE,
        entity_type="order",
        entity_id=order.order_no,
        actor=actor,
        before=_audit_value(before),
        after=_audit_value({
            "trade_date": order.trade_date,
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
    form_extra: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Order:
    """作废尚未登记事件的订单；已产生业务事实的订单必须走事件冲销。"""
    reason = _required_text(reason, field="reason", message="订单作废必须填写原因")
    order = get_order(session, order_id, user)
    posted = session.scalar(
        select(OrderEvent.id).where(
            OrderEvent.order_id == order.id,
            OrderEvent.is_posted.is_(True),
        )
    )
    if posted is not None:
        raise Validation("订单已有登记事件，不能直接作废，请先冲销")
    order.status = transition(ORDER_TRANSITIONS, order.status, "CANCEL", entity="订单")
    if form_extra:
        # ORDERCANC 作用域自定义字段值合并进订单 form_extra。
        checked = validate_form_extra(session, order_type_code="ORDERCANC", values=form_extra)
        order.form_extra = {**(order.form_extra or {}), **checked}
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
def pool_balances(
    session: Session, pool_ids: Iterable[int], user: CurrentUser | None = None
) -> dict[int, dict[str, Any]]:
    """批量资金池卡片：一次分组聚合覆盖全部池，避免逐池 7 次查询。

    口径与 ``pool_balance`` 完全一致，只是把「每池 5 次标量聚合 + 1 次押金」
    压成「一次 group by + 一次押金 group by」；池数量不再放大 SQL 条数。
    """
    from app.domain.trade import Deposit

    ids = list(dict.fromkeys(pool_ids))
    if not ids:
        return {}
    pools = {pool.id: pool for pool in session.scalars(select(Pool).where(Pool.id.in_(ids)))}
    for pool_id in ids:
        if pool_id not in pools or (
            user is not None and not user.can_see_pool(pool_id)
        ):
            raise NotFound(f"资金池 {pool_id} 不存在", details={"pool_id": pool_id})

    # (direction, nature) -> 已审金额合计；同一池多个 nature 会返回多行。
    cells: dict[int, dict[tuple[str, str], Decimal]] = {}
    for pool_id, direction, nature, amount in session.execute(
        select(
            Cashflow.pool_id,
            Cashflow.direction,
            Cashflow.nature,
            func.coalesce(func.sum(Cashflow.amount), 0),
        )
        .where(
            Cashflow.pool_id.in_(ids),
            Cashflow.status == CashflowStatus.APPROVED.value,
        )
        .group_by(Cashflow.pool_id, Cashflow.direction, Cashflow.nature)
    ):
        cells.setdefault(pool_id, {})[(direction, nature)] = to_money(amount or 0)
    deposits = {
        pool_id: to_money(amount or 0)
        for pool_id, amount in session.execute(
            select(
                Deposit.pool_id,
                func.coalesce(
                    func.sum(
                        Deposit.paid_amount
                        - Deposit.returned_amount
                        - Deposit.lost_amount
                    ),
                    0,
                ),
            )
            .where(Deposit.pool_id.in_(ids))
            .group_by(Deposit.pool_id)
        )
    }

    result: dict[int, dict[str, Any]] = {}
    for pool_id in ids:
        bucket = cells.get(pool_id, {})

        def total(direction: str, nature: str | None = None) -> Decimal:
            if nature is not None:
                return bucket.get((direction, nature), Decimal("0.00"))
            return sum(
                (amount for (d, _n), amount in bucket.items() if d == direction),
                Decimal("0.00"),
            )

        income = total(Direction.IN.value, Nature.BUSINESS_IN.value)
        expense = total(Direction.OUT.value, Nature.BUSINESS_OUT.value)
        transfer_in = total(Direction.IN.value, Nature.INTERNAL.value)
        transfer_out = total(Direction.OUT.value, Nature.INTERNAL.value)
        # 现金头寸包含 INTERNAL 划转；经营收入/支出仍只统计 BUSINESS_*，避免把划转算进损益。
        cash_balance = total(Direction.IN.value) - total(Direction.OUT.value)
        deposit_held = deposits.get(pool_id, Decimal("0.00"))
        pool = pools[pool_id]
        result[pool_id] = {
            "pool_id": pool.id,
            "pool_code": pool.code,
            "pool_name": pool.name,
            "income": income,
            "expense": expense,
            "transfer_in": transfer_in,
            "transfer_out": transfer_out,
            "cash_balance": cash_balance,
            "deposit_held": deposit_held,
            "available": cash_balance - deposit_held,
        }
    return result


def pool_balance(
    session: Session, pool_id: int, user: CurrentUser | None = None
) -> dict[str, Any]:
    """资金池卡片：经营收支、内部划转、押金占用与可用余额（单池）。"""
    return pool_balances(session, [pool_id], user=user)[pool_id]


__all__ = [
    "cancel_order",
    "create_order_link",
    "create_order",
    "get_order",
    "list_orders",
    "list_order_links",
    "pool_balance",
    "pool_balances",
    "post_event",
    "update_order",
]
