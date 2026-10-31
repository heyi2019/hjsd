"""orders.create：订单建档与参与方写入（ORD-01）。

建单只落订单主档与参与关系，金额一律由后续事件派生，不在建档时写汇总。
"""

from __future__ import annotations

from collections.abc import Mapping
from collections.abc import Sequence
from datetime import date
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from app.domain.users import User
from app.foundation import service as foundation_service
from app.orders.form_fields import validate_form_extra
from app.parties import service as parties_service
from app.policy import service as policy_service
from app.stocks import service as stocks_service
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    ErrorCode,
    Validation,
)
from app.domain.trade import (
    Order,
    OrderFormField,
)
from app.domain.enums import (
    AuditAction,
    CapitalType,
    CommissionMode,
    CommissionPayer,
    OrderStatus,
    PolicyType,
)

from ._shared import (
    _create_inline_inventory_account,
    _normalize_account_snapshot,
    _normalize_commission_value,
    _validate_existing_account_context,
    _validate_participant_roles,
    get_order,
)

def create_order(
    session: Session,
    *,
    order_type: str,
    trade_date: date,
    account_snapshot: dict[str, Any] | None = None,
    actor: str,
    account_id: int | None = None,
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
    # 账号资料的唯一输入是 account_snapshot；库存账号引用只传 account_id。
    if account_snapshot is not None and definition.code not in {"HS", "TH", "DG"}:
        raise Validation(f"业务类型 {definition.code} 不支持订单账号快照")
    if account_snapshot is not None:
        account_snapshot = _normalize_account_snapshot(account_snapshot)
    # 账号/产品扩展值以库存账号为事实来源；落订单前拆出账号字段，避免订单与库存双写。
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
        _validate_existing_account_context(
            definition.code,
            account,
            allow_consign_listing=(form_extra_scope or "").strip().upper() == "CONSIGN",
        )

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
    # 管理员或 ALL 范围建单未指定负责人时，负责人明确归属为操作人本人，
    # 这样订单不会因 owner_id 为空而脱离 SELF 用户的数据范围。
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

    # 快照是建单和内联建库的单一事实源；订单行只落快照，不再写平铺列。
    game_account = game_type = game_password = channel_region = None
    bound_phone = account_note = None
    has_secondary = None
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
    # HS/TH/DG 内联建库必须有账号快照；已有 account_id 的订单直接引用库存账号。
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


def add_customer_role(
    session: Session, order_id: int, customer_id: int, role: str, *,
    actor: str, user: CurrentUser | None = None,
) -> Order:
    """向已有订单追加客户角色（按 order_id+customer_id+role 去重）；

    用于库存售出时把买家挂到来源单——来源单在入库时已建档，售出不再新建订单。
    """
    order = get_order(session, order_id, user)
    from app.domain.parties import OrderCustomerRole
    from sqlalchemy import select

    existing = session.scalar(
        select(OrderCustomerRole.id).where(
            OrderCustomerRole.order_id == order_id,
            OrderCustomerRole.customer_id == customer_id,
            OrderCustomerRole.role == role,
        )
    )
    if existing is None:
        session.add(_customer_role(order_id, customer_id, role))
        session.flush()
    return order


def _counterparty_role(order_id: int, counterparty_id: int, role: str):
    from app.domain.parties import OrderCounterpartyRole

    return OrderCounterpartyRole(
        order_id=order_id, counterparty_id=counterparty_id, role=role
    )
