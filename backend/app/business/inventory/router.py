"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""

from datetime import date
from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    CurrentUser,
)
from app.settings.auth.session import (
    require_permissions,
)
from app.domain.enums import AuditAction
from app.settings.lists.export import build_list_csv
from app.settings.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.business.inventory.inventory import (
    inventory_ledger as query_inventory_ledger,
    list_accounts as query_inventory_accounts,
)
from app.business.inventory.deletion import delete_inventory as delete_inventory_record
from app.business.inventory.export import build_inventory_ledger_csv
from app.shared.audit import record_audit
from app.core.errors import PermissionDenied

from .schemas import (
    AccountDeleteRequest,
    InventoryLedgerOut,
)

from .router_output import (
    _actor,
    _account_outputs,
)
from app.business.inventory.collaboration import build_order_list_payload

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)

@router.get("/stocks/export.csv")
def export_accounts_csv(
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> Response:
    """库存中心按可见列导出 CSV，沿用 /stocks 的权限口径。"""
    accounts = query_inventory_accounts(
        db, status=status, user=_user, limit=None, offset=0
    )
    outputs = _account_outputs(
        db,
        accounts,
        _user,
    )
    # 「在手时间」列的注册键是 inventory_age，而响应字段叫 inventory_age_days，
    # 不补别名整列会导出成空（列在、值没有）。格式与前端本地导出保持一致：`N天`。
    # 「状态」列（注册键 status）在界面上展示的是**库存状态**（在库/出库），
    # 不是库存周期状态（WAITING/SOLD/VOID）；不覆盖就会导出另一套值域的裸码。
    rows = [
        {
            **output.model_dump(),
            "status": output.inventory_status,
            "inventory_age": "" if output.inventory_age_days is None else f"{output.inventory_age_days}天",
        }
        for output in outputs
    ]
    csv_text, meta = build_list_csv(db, "INVENTORY", rows)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="INVENTORY",
        actor=_user.username,
        after={
            "rows": meta["row_count"],
            "column_count": meta["column_count"],
            "truncated": meta["truncated"],
        },
    )
    return file_response(csv_text, f"库存中心-{date.today().isoformat()}.csv", CSV_MEDIA_TYPE)


def _require_admin(user: CurrentUser) -> None:
    """删除不可逆：权限收紧到系统管理员，operator/finance 即使有建单权也不可删。"""
    if not user.is_admin:
        raise PermissionDenied("仅系统管理员可执行删除")


@router.delete("/stocks/{account_id}", status_code=204, response_model=None)
def delete_inventory(
    account_id: int,
    payload: AccountDeleteRequest,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> Response:
    """删除及其全部订单从属数据（仅管理员）。

    请求体必带删除原因（空白一律 422）；库存及其订单/事件/流水/返点等从属数据
    全部物理删除，库存快照与原因写入审计日志，操作不可恢复。
    """
    _require_admin(user)
    delete_inventory_record(db, account_id, actor=_actor(user), reason=payload.reason, user=user)
    return Response(status_code=204)


@router.get("/stocks/inventory/ledger", response_model=InventoryLedgerOut)
def inventory_ledger(
    business_mode: str | None = Query(default=None),
    inventory_type: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    inventory_operator_ids: list[int] | None = Query(default=None),
    age_gt_days: int | None = Query(default=None, gt=0),
    sort_desc: bool = Query(default=True),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    include_images: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> InventoryLedgerOut:
    """库存台账服务端筛选与分页；响应只包含当前页明细和后端汇总。"""
    result = query_inventory_ledger(
        db, business_mode=business_mode, inventory_type=inventory_type,
        game_type=game_type, keyword=keyword, date_from=date_from,
        date_to=date_to, inventory_operator_ids=inventory_operator_ids,
        age_gt_days=age_gt_days,
        sort_desc=sort_desc, limit=limit, offset=offset, user=user, include_images=include_images,
    )
    pairs = result["items"]
    accounts = [account for account, _order in pairs]
    orders = [order for _account, order in pairs]
    account_outputs = _account_outputs(db, accounts, user, loaded_orders=orders, include_images=include_images)
    order_outputs = build_order_list_payload(db, orders, accounts=accounts)
    return InventoryLedgerOut(
        items=[{"account": account, "order": order}
               for account, order in zip(account_outputs, order_outputs, strict=True)],
        total=result["total"], facet_total=result["facet_total"], type_counts=result["type_counts"],
        game_types=result["game_types"], stats=result["stats"],
    )


@router.get("/stocks/inventory/ledger/export.csv")
def export_inventory_ledger_csv(
    business_mode: str | None = Query(default=None),
    inventory_type: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    inventory_operator_ids: list[int] | None = Query(default=None),
    age_gt_days: int | None = Query(default=None, gt=0),
    sort_desc: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> Response:
    """按库存中心当前筛选口径导出；明细读取与 CSV 拼装不再由浏览器承担。"""
    result = query_inventory_ledger(
        db,
        business_mode=business_mode,
        inventory_type=inventory_type,
        game_type=game_type,
        keyword=keyword,
        date_from=date_from,
        date_to=date_to,
        inventory_operator_ids=inventory_operator_ids,
        age_gt_days=age_gt_days,
        sort_desc=sort_desc,
        limit=None,
        offset=0,
        user=user,
    )
    pairs = result["items"]
    accounts = _account_outputs(db, [account for account, _order in pairs], user,
                                loaded_orders=[order for _account, order in pairs])
    csv_text, failed_details = build_inventory_ledger_csv(
        pairs,
        accounts,
        db=db,
        user=user,
    )
    response = file_response(
        csv_text,
        f"库存中心-{date.today().isoformat()}.csv",
        CSV_MEDIA_TYPE,
    )
    response.headers["X-Inventory-Detail-Failures"] = str(failed_details)
    record_audit(
        db,
        action=AuditAction.LIST_EXPORT,
        entity_type="list_export",
        entity_id="INVENTORY",
        actor=user.username,
        after={
            "rows": len(pairs),
            "total": result["total"],
            "truncated": False,
            "detail_failures": failed_details,
        },
    )
    return response


__all__ = ["router"]
