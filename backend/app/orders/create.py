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
    Account,
    Order,
    OrderFormField,
)
from app.domain.enums import (
    AccountStatus,
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


def _assert_no_duplicate_inventory_account(
    session: Session,
    *,
    game_account: str,
    game_type: str | None,
    confirm_repurchase: bool,
) -> None:
    """建单判重：同一游戏账号 + 游戏类型不得重复进入库存。

    口径（原前端建单弹窗的逻辑，现由后端统一判定）：

    - 已有**未售出**账号（除 ``SOLD`` / ``VOID`` 外的任何状态）→ 直接拒绝；
    - 仅**已售出**记录 → 视为复购回流，需 ``confirm_repurchase`` 显式确认；
    - ``VOID``（已取消/作废）不参与判重，取消后可用同一账号重新建单。

    缺 ``game_type`` 时无法精确匹配，跳过判重（与前端原口径一致）。
    """
    if not game_type:
        return
    rows = list(
        session.scalars(
            select(Account).where(
                Account.game_account == game_account,
                Account.game_type == game_type,
                Account.status != AccountStatus.VOID.value,
            )
        ).all()
    )
    if not rows:
        return
    unsold = [row for row in rows if row.status != AccountStatus.SOLD.value]
    reported = unsold or rows
    details = {
        "field": "game_account",
        "game_account": game_account,
        "game_type": game_type,
        "account_ids": [row.id for row in reported],
        "stock_nos": [row.stock_no for row in reported],
    }
    if unsold:
        raise Validation(
            f"已有未售出库存账号「{game_account}」，请先售出后再建单",
            code=ErrorCode.INVENTORY_ACCOUNT_IN_STOCK,
            details=details,
        )
    if not confirm_repurchase:
        raise Validation(
            f"历史库存账号「{game_account}」已售出，请确认是否为复购回流订单",
            code=ErrorCode.REPURCHASE_CONFIRM_REQUIRED,
            details=details,
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

    # 建单判重：只在新建库存账号时判，引用已有账号（如库存寄售上架）不判。
    if account_id is None and game_account:
        _assert_no_duplicate_inventory_account(
            session,
            game_account=game_account,
            game_type=game_type,
            confirm_repurchase=confirm_repurchase,
        )

    # 内联建库存账号（2026-10-28 口径）：建单成功即生成库存编号，不再等 BUY 事件。
    # HS/TH/DG 内联建库必须有账号快照；已有 account_id 的订单直接引用库存账号。
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
        order_no=foundation_service.next_order_no(session, definition),
        order_type=definition.code,
        capital_type=selected_capital_type,
        trade_date=trade_date,
        account_snapshot=order_account_snapshot,
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
    # 与建单同一套参与方护栏：角色合法、符合订单类型白名单、客户仍可用。
    # 缺任一校验都会让「售后追挂买家」绕过停用/合并客户与角色白名单。
    _validate_participant_roles(order.order_type, [(customer_id, role)], [])
    parties_service.assert_customer_usable(session, customer_id, user=user)
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
