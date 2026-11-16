"""accounts.router：账号台账 API（ACC-01）。

账号状态与成本由订单事件驱动，本模块**不提供**改状态/改成本入口（ACC-01-03/04）。
"""

from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_UPDATE,
    CurrentUser,
    require_permissions,
)
from app.domain.enums import AuditAction
from app.lists.export import EXPORT_ROW_LIMIT, build_list_csv
from app.lists.file_response import CSV_MEDIA_TYPE, file_response
from app.stocks.inventory import (
    count_accounts,
    inventory_ledger as stocks_inventory_ledger,
    inventory as stocks_inventory,
    inventory_cost_by_entry_date as stocks_inventory_cost_by_entry_date,
    inventory_stats as stocks_inventory_stats,
    list_accounts as stocks_list_accounts,
)
from app.stocks.profile import (
    get_account,
    update_account_profile as stocks_update_account_profile,
)
from app.stocks.deletion import delete_inventory as stocks_delete_inventory
from app.parties.fields import get_extra_values
from app.core.audit import record_audit
from app.core.errors import PermissionDenied

from .schemas import (
    AccountOut,
    AccountListOut,
    AccountProfileUpdate,
    AccountDeleteRequest,
    InventoryCostSummaryOut,
    InventoryResponseOut,
    InventoryStatsOut,
    InventoryStatsQuery,
    InventoryLedgerOut,
)

from .router_output import (
    _actor,
    _account_output,
    _account_outputs,
)
from app.orders.router_output import _order_list_payload

router = APIRouter(tags=["ACC-01 账号台账"])

read_access = require_permissions(PERM_ORDER_CREATE, PERM_FINANCE_READ, require_all=False)
manage = require_permissions(PERM_ORDER_CREATE)
@router.get("/stocks", response_model=AccountListOut)
def list_accounts(
    status: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> AccountListOut:
    items = stocks_list_accounts(db, status=status, user=_user, limit=limit, offset=offset)
    return AccountListOut(
        items=_account_outputs(
            db,
            items,
            _user,
        ),
        total=count_accounts(db, status=status, user=_user),
        limit=limit,
        offset=offset,
    )


@router.get("/stocks/export.csv")
def export_accounts_csv(
    status: str | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> Response:
    """库存中心按可见列导出 CSV，沿用 /stocks 的权限口径。"""
    accounts = stocks_list_accounts(
        db, status=status, user=_user, limit=EXPORT_ROW_LIMIT, offset=0
    )
    outputs = _account_outputs(
        db,
        accounts,
        _user,
    )
    # 「未售时长」列的注册键是 inventory_age，而响应字段叫 inventory_age_days，
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


@router.patch("/stocks/{account_id}", response_model=AccountOut)
def update_account_profile(
    account_id: int,
    payload: AccountProfileUpdate,
    db: Session = Depends(get_db),
    user: CurrentUser = manage,
) -> AccountOut:
    get_account(db, account_id, user)
    changes = {
        field: getattr(payload, field)
        for field in payload.model_fields_set
    }
    item = stocks_update_account_profile(
        db, account_id, actor=_actor(user), user=user, **changes
    )
    extras = get_extra_values(db, entity_type="account", entity_id=item.id)
    return _account_output(item, extra_values=extras)


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
    stocks_delete_inventory(db, account_id, actor=_actor(user), reason=payload.reason, user=user)
    return Response(status_code=204)


@router.get("/stocks/inventory", response_model=InventoryResponseOut)
def inventory(
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryResponseOut:
    """库存中心在库台账：只统计独立库存状态为在库的真实占用。"""
    rows = stocks_inventory(db, user=_user)
    total = sum((row["cost_amount"] for row in rows), Decimal("0"))
    return InventoryResponseOut(items=rows, count=len(rows), total_cost=total)


@router.get("/stocks/inventory/cost-summary", response_model=InventoryCostSummaryOut)
def inventory_cost_summary(
    entry_date_from: date | None = Query(default=None),
    entry_date_to: date | None = Query(default=None),
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryCostSummaryOut:
    """按入库日期范围返回在库账号成本汇总，不返回库存行。"""
    total_cost = stocks_inventory_cost_by_entry_date(
        db,
        date_from=entry_date_from,
        date_to=entry_date_to,
        user=_user,
    )
    return InventoryCostSummaryOut(total_cost=total_cost)


@router.get("/stocks/inventory/ledger", response_model=InventoryLedgerOut)
def inventory_ledger(
    business_mode: str | None = Query(default=None),
    inventory_type: str | None = Query(default=None),
    game_type: str | None = Query(default=None),
    keyword: str | None = Query(default=None, max_length=128),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    sort_desc: bool = Query(default=True),
    limit: int = Query(default=10, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    user: CurrentUser = read_access,
) -> InventoryLedgerOut:
    """库存台账服务端筛选与分页；响应只包含当前页明细和后端汇总。"""
    result = stocks_inventory_ledger(
        db, business_mode=business_mode, inventory_type=inventory_type,
        game_type=game_type, keyword=keyword, date_from=date_from,
        date_to=date_to, sort_desc=sort_desc, limit=limit, offset=offset, user=user,
    )
    pairs = result["items"]
    accounts = [account for account, _order in pairs]
    orders = [order for _account, order in pairs]
    account_outputs = _account_outputs(db, accounts, user)
    order_outputs = _order_list_payload(db, orders)
    return InventoryLedgerOut(
        items=[{"account": account, "order": order}
               for account, order in zip(account_outputs, order_outputs, strict=True)],
        total=result["total"], facet_total=result["facet_total"], type_counts=result["type_counts"],
        game_types=result["game_types"], stats=result["stats"],
    )


@router.post("/stocks/inventory/stats", response_model=InventoryStatsOut)
def inventory_stats(
    payload: InventoryStatsQuery,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_access,
) -> InventoryStatsOut:
    """汇总当前可见账号的占用成本与库龄档位。

    入参是界面此刻展示的账号集合，因此筛选口径只有一份（前端视图），
    金额累加与库龄天数只在后端算，前端不再做 float 求和。
    """
    stats = stocks_inventory_stats(db, account_ids=payload.account_ids, user=_user)
    return InventoryStatsOut(**stats)




__all__ = ["router"]
