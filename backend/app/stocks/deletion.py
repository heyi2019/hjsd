"""库存删除服务。

库存删除是管理员专属的不可恢复动作。库存编号与订单编号一对一绑定：
库存入口先删除绑定订单，再复用本模块的主档删除步骤；审计记录由各自服务写入并保留。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.domain.enums import AuditAction
from app.domain.imports import ImportRow
from app.domain.trade import Account, InstallmentDisposition, Order

from .profile import get_account


def delete_inventory(
    session: Session,
    inventory_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
) -> None:
    """删除及其全部绑定订单从属数据，保留审计记录。

    客户、合作方、导入批次等共享主数据不属于库存删除范围；库存关联的订单、
    事件、资金流水、分润、分期、返点、押金、订单关系和映射全部清理。
    """
    inventory = get_account(session, inventory_id, user)
    cleaned_reason = _clean_reason(reason)
    linked_order = _linked_order(session, inventory_id)

    if linked_order is not None:
        # 经 stocks.collaboration 注册点调用 orders.deletion.delete_order，
        # stocks 不反向 import orders（2026-11-18 P0-A 第三批）。
        from .collaboration import delete_linked_order

        delete_linked_order(
            session,
            linked_order[0],
            actor=actor,
            reason=f"随库存 {inventory.stock_no or inventory_id} 删除：{cleaned_reason}",
            user=user,
            delete_inventory_after=False,
        )

    delete_inventory_record(
        session,
        inventory_id,
        actor=actor,
        reason=cleaned_reason,
        user=user,
        deleted_order=linked_order,
    )


def delete_inventory_record(
    session: Session,
    inventory_id: int,
    *,
    actor: str,
    reason: str,
    user: CurrentUser | None = None,
    deleted_order: tuple[int, str] | None = None,
) -> None:
    """删除库存主档及其非订单从属数据；调用方已完成订单删除。"""
    inventory = get_account(session, inventory_id, user)
    cleaned_reason = _clean_reason(reason)

    # 处置记录的 account_id 是 RESTRICT 且不一定挂在当前订单上，也属于库存从属数据。
    session.query(InstallmentDisposition).filter(
        InstallmentDisposition.account_id == inventory_id
    ).delete(synchronize_session=False)

    before = _inventory_snapshot(inventory)

    # 导入原始行是共享历史数据，只解除库存映射，不删除原始行。
    import_row_count = (
        session.query(ImportRow)
        .filter(ImportRow.mapped_account_id == inventory_id)
        .update({ImportRow.mapped_account_id: None}, synchronize_session=False)
    )
    session.delete(inventory)
    session.flush()

    record_audit(
        session,
        action=AuditAction.ACCOUNT_DELETE,
        entity_type="account",
        entity_id=inventory.stock_no or str(inventory_id),
        actor=actor,
        before=before,
        after={
            "deleted": True,
            "deleted_orders": (
                [{"id": deleted_order[0], "order_no": deleted_order[1]}]
                if deleted_order
                else []
            ),
            "unlinked_import_rows": import_row_count,
        },
        reason=cleaned_reason,
    )


def _clean_reason(reason: str) -> str:
    cleaned = reason.strip()
    if not cleaned:
        raise Validation("删除原因不能为空", details={"field": "reason"})
    return cleaned


def _linked_order(session: Session, inventory_id: int) -> tuple[int, str] | None:
    return session.execute(
        select(Order.id, Order.order_no).where(Order.account_id == inventory_id)
    ).one_or_none()


def _inventory_snapshot(inventory: Account) -> dict[str, object]:
    return {
        "id": inventory.id,
        "stock_no": inventory.stock_no,
        "game_account": inventory.game_account,
        "camp_account": inventory.camp_account,
        "game_type": inventory.game_type,
        "business_mode": inventory.business_mode,
        "inventory_type": inventory.inventory_type,
        "value_added_service": inventory.value_added_service,
        "status": inventory.status,
        "inventory_status": inventory.inventory_status,
        "cost_amount": str(inventory.cost_amount),
        "buy_date": inventory.buy_date.isoformat() if inventory.buy_date else None,
        "inventory_entry_at": inventory.inventory_entry_at.isoformat()
        if inventory.inventory_entry_at
        else None,
        "note": inventory.note,
        "created_by": inventory.created_by,
    }


__all__ = ["delete_inventory", "delete_inventory_record"]
