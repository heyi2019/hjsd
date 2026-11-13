"""orders._shared：订单服务共用的审计序列化、账号快照归一与订单读取。
"""

from __future__ import annotations

from collections.abc import Mapping
from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from typing import Any
from pydantic import ValidationError as PydanticValidationError
from app.core.security import CurrentUser
from app.core.security import owner_scope_ids
from app.orders.schemas import OrderAccountSnapshot
from app.stocks.profile import create_account
from sqlalchemy.orm import Session
from app.core.errors import (
    ErrorCode,
    NotFound,
    Validation,
)
from app.domain.trade import (
    Account,
    Order,
)
from app.domain.enums import (
    BusinessMode,
    CounterpartyRole,
    CustomerRole,
    InventoryType,
)

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


def _validate_existing_account_context(
    order_type: str,
    account: Account,
) -> None:
    """新建订单必须与已引用库存账号的业务类型匹配。"""
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
}
_COUNTERPARTY_ROLES_BY_ORDER_TYPE: dict[str, frozenset[str]] = {
    "HS": frozenset(),
    "TH": frozenset({"PEER"}),
    "DG": frozenset({"PLATFORM"}),
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
def _create_inline_inventory_account(session: Session, *, order_type: str, game_account: str, actor: str, game_type: str | None, game_password: str | None, channel_region: str | None, bound_phone: str | None, has_secondary: bool | None, account_note: str | None, value_added_service: str | None = None, platform: str | None = None, wallet_realname: str | None = None, camp_account: str | None = None, secondary_images: list[str] | None = None, wallet_realname_images: list[str] | None = None, extra_values: Mapping[str, Any] | None = None) -> Account:
    mode, inventory_type = {
        "HS": ("SELF", "RECOVERY"),
        "TH": ("DISTRIBUTION", "PICKUP"),
        "DG": ("DISTRIBUTION", "CONSIGNMENT"),
    }[order_type]
    return create_account(
        session, game_account=game_account, actor=actor, game_type=game_type,
        business_mode=mode, inventory_type=inventory_type, game_password=game_password,
        channel_region=channel_region, bound_phone=bound_phone,
        has_secondary=has_secondary, note=account_note,
        value_added_service=value_added_service, platform=platform,
        wallet_realname=wallet_realname,
        camp_account=camp_account,
        secondary_images=secondary_images,
        wallet_realname_images=wallet_realname_images,
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


def get_order(session: Session, order_id: int, user: CurrentUser | None = None) -> Order:
    order = session.get(Order, order_id)
    if order is None:
        raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    if user is not None and user.owner_scope != "ALL" and not user.is_admin:
        visible_ids = owner_scope_ids(session, user)
        if order.owner_id not in (visible_ids or set()):
            raise NotFound(f"订单 {order_id} 不存在", details={"order_id": order_id})
    return order
