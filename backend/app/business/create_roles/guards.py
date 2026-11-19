"""建单守卫：库存账号判重。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ErrorCode, Validation
from app.domain.enums import AccountStatus
from app.domain.trade import Account

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
