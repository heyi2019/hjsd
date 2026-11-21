"""orders.create：订单建档与参与方写入（ORD-01）。

建单只落订单主档与参与关系，金额一律由后续事件派生，不在建档时写汇总。

参与方校验与角色写入位于 `create_roles/`，本文件负责建单编排。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any

from app.shared.audit import record_audit
from app.core.security import CurrentUser
from app.domain.users import User
from app.settings.field_definitions.order_types import get_order_type_by_code
from app.settings.field_definitions.sequences import next_order_no
from app.shared.form_field_rules import validate_business_responsible, validate_form_extra
from app.customers.counterparties import assert_counterparty_usable
from app.customers.customer_merge import assert_customer_usable
from app.shared.form_values import set_extra_values
from app.business.inventory.profile import get_account
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import ErrorCode, Validation
from app.domain.trade import Account, Order, OrderFormField
from app.domain.enums import AuditAction, OrderStatus

from app.business._shared import (
    _create_inline_inventory_account,
    _normalize_account_snapshot,
    _validate_existing_account_context,
    _validate_participant_roles,
)
from app.business.orders.create_roles.guards import (
    _assert_no_duplicate_inventory_account,
)
from app.business.orders.create_roles.roles import (
    _counterparty_role,
    _customer_role,
    add_counterparty_role,
    add_customer_role,
)

def create_order(
    session: Session,
    *,
    order_type: str,
    trade_date: date,
    account_snapshot: dict[str, Any] | None = None,
    actor: str,
    account_id: int | None = None,
    confirm_repurchase: bool = False,
    owner_id: int | None = None,
    note: str | None = None,
    customer_roles: Sequence[tuple[int, str]] = (),
    counterparty_roles: Sequence[tuple[int, str]] = (),
    extra_values: Mapping[str, Any] | None = None,
    form_extra: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> Order:
    definition = get_order_type_by_code(session, order_type)
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
    if account_snapshot is not None and account_id is not None:
        raise Validation(
            "账号快照与库存账号不能同时提交",
            details={"account_snapshot": True, "account_id": account_id},
        )
    if account_snapshot is not None and definition.code not in {"HS", "TH", "DG"}:
        raise Validation(f"业务类型 {definition.code} 不支持订单账号快照")
    if account_snapshot is not None:
        account_snapshot = _normalize_account_snapshot(account_snapshot)
    # 账号/产品扩展值以库存账号为事实来源；落订单前拆出账号字段，避免订单与库存双写。
    snapshot_extra = dict((account_snapshot or {}).get("extra_values") or {})
    submitted_extra = dict(form_extra or {})
    merged_extra = {**snapshot_extra, **submitted_extra}
    if account_snapshot is not None and "bound_phone" in account_snapshot and "bound_phone" not in merged_extra:
        merged_extra["bound_phone"] = account_snapshot.get("bound_phone")
    form_extra = validate_form_extra(
        session,
        order_type_code=definition.code,
        values=merged_extra,
        context={
            **(account_snapshot or {}),
            "has_secondary": (
                "有" if (account_snapshot or {}).get("has_secondary") is True
                else "无" if (account_snapshot or {}).get("has_secondary") is False
                else None
            ),
            "game_account_note": (account_snapshot or {}).get("note"),
            "trade_date": trade_date,
            "note": note,
        },
    )
    validate_business_responsible(
        session,
        order_type_code=definition.code,
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
    if account_id is not None:
        account = get_account(session, account_id, user)
        _validate_existing_account_context(
            definition.code,
            account,
        )
        bound_order = session.execute(
            select(Order.id, Order.order_no).where(Order.account_id == account_id)
        ).one_or_none()
        if bound_order is not None:
            raise Validation(
                "库存账号已绑定订单，不能重复建单",
                details={
                    "account_id": account_id,
                    "bound_order_id": bound_order.id,
                    "bound_order_no": bound_order.order_no,
                },
            )

    _validate_participant_roles(
        definition.code, customer_roles, counterparty_roles
    )
    customer_participants = [
        (
            customer_id,
            role,
            assert_customer_usable(session, customer_id, user=user),
        )
        for customer_id, role in customer_roles
    ]
    counterparty_participants = [
        (
            counterparty_id,
            role,
            assert_counterparty_usable(
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

    # 快照是建单和内联建库的单一事实源；订单行只落快照，不再写平铺列。
    game_account = game_type = game_password = channel_region = None
    camp_account = None
    secondary_images = None
    wallet_realname_images = None
    bound_phone = account_note = wallet_realname = None
    has_secondary = None
    if account_snapshot is not None and definition.code in {"HS", "TH", "DG"}:
        snap = account_snapshot
        game_account = snap["game_account"]
        game_type = snap.get("game_type")
        game_password = snap.get("game_password")
        camp_account = snap.get("camp_account")
        channel_region = snap.get("channel_region")
        bound_phone = snap.get("bound_phone")
        has_secondary = snap.get("has_secondary")
        secondary_images = snap.get("secondary_images")
        wallet_realname = snap.get("wallet_realname")
        wallet_realname_images = snap.get("wallet_realname_images")
        account_note = snap.get("note")

    # 建单判重：只在新建库存账号时判，引用已有账号不判。
    if account_id is None and game_account:
        _assert_no_duplicate_inventory_account(
            session,
            game_account=game_account,
            game_type=game_type,
            confirm_repurchase=confirm_repurchase,
        )

    # 内联建库存账号：建单成功即生成库存编号，不再等 BUY 事件。
    if definition.code in {"HS", "TH"} and account_id is None and game_account:
        account_id = _create_inline_inventory_account(
            session, order_type=definition.code, game_account=game_account, actor=actor,
            game_type=game_type, game_password=game_password, channel_region=channel_region,
            bound_phone=bound_phone, has_secondary=has_secondary, account_note=account_note,
            wallet_realname=wallet_realname, camp_account=camp_account,
            secondary_images=secondary_images,
            wallet_realname_images=wallet_realname_images,
            extra_values=(account_snapshot or {}).get("extra_values"),
        ).id

    if definition.code == "DG" and account_id is None and game_account:
        account_id = _create_inline_inventory_account(
            session, order_type=definition.code, game_account=game_account, actor=actor,
            game_type=game_type, game_password=game_password, channel_region=channel_region,
            bound_phone=bound_phone, has_secondary=has_secondary, account_note=account_note,
            wallet_realname=wallet_realname, camp_account=camp_account,
            secondary_images=secondary_images,
            wallet_realname_images=wallet_realname_images,
            extra_values=(account_snapshot or {}).get("extra_values"),
        ).id

    # 二次图片是账号私有资料（data URL 体积大），只入库存账号，不复制进订单快照。
    order_account_snapshot = account_snapshot
    if account_snapshot is not None and (
        "secondary_images" in account_snapshot or "wallet_realname_images" in account_snapshot
    ):
        order_account_snapshot = {
            key: value
            for key, value in account_snapshot.items()
            if key not in {"secondary_images", "wallet_realname_images"}
        }
    order = Order(
        order_no=next_order_no(session, definition),
        order_type=definition.code,
        trade_date=trade_date,
        account_snapshot=order_account_snapshot,
        account_id=account_id,
        status=OrderStatus.ACTIVE.value,
        owner_id=owner_id,
        note=note,
        form_extra=dict(form_extra) if form_extra else None,
        created_by=actor,
        updated_by=actor,
    )
    session.add(order)
    session.flush()
    # 入库时间以建单成功时间为准，而不是账号资料开始填写的时间。
    # 数据库存储精确到秒，前端展示时再收敛到分钟；若后续建单流程失败，外层事务会整体回滚。
    if order.account_id is not None:
        account = session.get(Account, order.account_id)
        if account is not None:
            account.inventory_entry_at = order.created_at.replace(microsecond=0)

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
    set_extra_values(
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


__all__ = [
    "create_order",
    "add_customer_role",
    "add_counterparty_role",
    "_assert_no_duplicate_inventory_account",
    "_customer_role",
    "_counterparty_role",
]
