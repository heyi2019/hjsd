"""建单守卫：库存账号判重与佣金口径归一化。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ErrorCode, Validation
from app.domain.enums import AccountStatus, CommissionMode, CommissionPayer
from app.domain.trade import Account
from app.orders._shared import _normalize_commission_value

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

    缺 ``game_type`` 时按账号单键判重，避免调用方通过省略产品类型绕过库存保护。
    """
    filters = [
        Account.game_account == game_account,
        Account.status != AccountStatus.VOID.value,
    ]
    if game_type:
        filters.append(Account.game_type == game_type)
    rows = list(
        session.scalars(
            select(Account).where(*filters)
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


def _normalize_commission_context(
    *,
    commission_mode: str | None,
    commission_payer: str | None,
    order_type_code: str,
) -> tuple[str | None, str | None]:
    """佣金口径校验：仅 DG 可用、支付方式与承担方成对，DB CHECK 同口径。"""
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
        if order_type_code != "DG":
            raise Validation(
                "只有 DG 代挂订单可以填写佣金口径",
                details={"order_type": order_type_code},
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
    return normalized_commission_mode, normalized_commission_payer
