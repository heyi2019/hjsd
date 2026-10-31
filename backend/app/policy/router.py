"""policy.router：经营规则配置与订单利润分配（T19 / T20）。"""
from __future__ import annotations

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_ORDER_CREATE,
    PERM_POLICY_MANAGE,
    CurrentUser,
    require_permissions,
)
from app.orders.amounts import order_amounts
from app.policy import schemas, service

router = APIRouter(tags=["policy"])
manage_access = require_permissions(PERM_POLICY_MANAGE)
# 注意：require_permissions 返回的已是 Depends 对象，直接作默认值，不要再包一层。
# 规则配置只对规则管理员开放（2026-10-26 起取消独立的「审核」权限：保存即发布，
# 发布人取当前登录用户，无单独审批环节）。
policy_read_access = require_permissions(PERM_POLICY_MANAGE)
# 订单自身的规则快照/利润分配属于订单数据，沿用订单读取门控并继续由 Service 做范围隔离。
order_policy_read_access = require_permissions(PERM_ORDER_CREATE)


# ── T19 / BAS-06-01：规则定义 ───────────────────────────────────

@router.get("/policies", response_model=schemas.PolicyDefinitionListOut)
def list_definitions(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = policy_read_access,
    status: str | None = Query(default=None),
    policy_code: str | None = Query(default=None),
) -> schemas.PolicyDefinitionListOut:
    """规则列表：按规则、范围、版本、生效期管理（BAS-06-01）。"""
    items = service.list_definitions(db, status=status, policy_code=policy_code)
    return schemas.PolicyDefinitionListOut(
        items=[schemas.PolicyDefinitionOut.model_validate(item) for item in items],
        total=len(items),
    )


@router.post("/policies", response_model=schemas.PolicyDefinitionOut)
def create_definition(
    payload: schemas.PolicyDefinitionCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.PolicyDefinitionOut:
    return schemas.PolicyDefinitionOut.model_validate(service.create_definition(
        db,
        policy_code=payload.policy_code,
        name=payload.name,
        scope_type=payload.scope_type,
        scope_id=payload.scope_id,
        description=payload.description,
        actor=user.username,
    ))


@router.get("/policies/{definition_id}", response_model=schemas.PolicyDefinitionOut)
def get_definition(
    definition_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = policy_read_access,
) -> schemas.PolicyDefinitionOut:
    return schemas.PolicyDefinitionOut.model_validate(service.get_definition(db, definition_id))


@router.get("/policies/{definition_id}/versions", response_model=schemas.PolicyVersionListOut)
def list_versions(
    definition_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = policy_read_access,
    status: str | None = Query(default=None),
) -> schemas.PolicyVersionListOut:
    items = service.list_versions(db, definition_id, status=status)
    return schemas.PolicyVersionListOut(
        items=[schemas.PolicyVersionOut.model_validate(item) for item in items],
        total=len(items),
    )


# ── T19 / BAS-06-02：版本 ───────────────────────────────────────

@router.post(
    "/policies/{definition_id}/versions",
    response_model=schemas.PolicyVersionOut,
)
def create_version(
    definition_id: int,
    payload: schemas.PolicyVersionCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.PolicyVersionOut:
    """新增规则版本。生效期不得与已有版本重叠（BAS-06-02）。"""
    return schemas.PolicyVersionOut.model_validate(service.create_version(
        db,
        definition_id,
        effective_from=payload.effective_from,
        effective_to=payload.effective_to,
        config=payload.config,
        note=payload.note,
        actor=user.username,
    ))


@router.patch("/policy-versions/{version_id}", response_model=schemas.PolicyVersionOut)
def update_version(
    version_id: int,
    payload: schemas.PolicyVersionUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.PolicyVersionOut:
    """只允许改草稿版本；已发布版本必须新建（BAS-06-02）。"""
    return schemas.PolicyVersionOut.model_validate(
        service.update_version_draft(db, version_id, config=payload.config, actor=user.username)
    )


@router.post(
    "/policy-versions/{version_id}/supersede", response_model=schemas.PolicyVersionOut
)
def supersede_version(
    version_id: int,
    payload: schemas.PolicyVersionSupersede,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.PolicyVersionOut:
    """作废草稿版本（SUPERSEDED）。已发布版本不可作废——它是历史日期的解析口径。"""
    return schemas.PolicyVersionOut.model_validate(
        service.supersede_draft_version(
            db,
            version_id,
            actor=user.username,
            reason=payload.reason,
            replaced_by_version_id=payload.replaced_by_version_id,
        )
    )


@router.post("/policies/versions/expire-sweep", response_model=schemas.PolicyExpireSweepOut)
def expire_sweep(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
    on: date = Query(...),
) -> schemas.PolicyExpireSweepOut:
    """把生效期已结束（effective_to < on）的 ACTIVE 版本固化为 EXPIRED。"""
    return schemas.PolicyExpireSweepOut.model_validate(
        service.expire_lapsed_versions(db, on=on, actor=user.username)
    )


@router.get("/policy-versions/resolve", response_model=schemas.PolicyResolveOut)
def resolve(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = policy_read_access,
    policy_code: str = Query(...),
    on: date = Query(...),
    scope_type: str = Query(default="GLOBAL"),
    scope_id: int | None = Query(default=None),
) -> schemas.PolicyResolveOut:
    """取某日某作用域生效版本（BAS-06-04 快照固化的依据）。"""
    version = service.resolve_version(
        db,
        policy_code=policy_code,
        on=on,
        scope_type=scope_type,
        scope_id=scope_id,
    )
    from app.policy.service import _ver_out  # noqa: PLC0415

    return schemas.PolicyResolveOut(
        found=version is not None,
        version=schemas.PolicyVersionOut.model_validate(_ver_out(version)) if version else None,
    )


# ── T20 / BAS-06-03：订单利润分配 ────────────────────────────────

@router.get(
    "/orders/{order_id}/profit-allocations",
    response_model=schemas.ProfitAllocationListOut,
)
def list_allocations(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = order_policy_read_access,
) -> schemas.ProfitAllocationListOut:
    items = service.list_allocations(db, order_id, user=user)
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in items],
        total=len(items),
        order_profit=order_amounts(db, order_id)["PROFIT"],
    )


@router.put(
    "/orders/{order_id}/profit-allocations",
    response_model=schemas.ProfitAllocationListOut,
)
def set_allocations(
    order_id: int,
    payload: schemas.ProfitAllocationSet,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = manage_access,
) -> schemas.ProfitAllocationListOut:
    """整单设置利润分配。有效比例合计必须为 100%（BAS-06-03）。"""
    items = service.set_allocations(
        db,
        order_id,
        items=[item.model_dump() for item in payload.items],
        actor=user.username,
        form_extra=payload.form_extra,
        user=user,
    )
    return schemas.ProfitAllocationListOut(
        items=[schemas.ProfitAllocationOut.model_validate(item) for item in items],
        total=len(items),
        order_profit=order_amounts(db, order_id)["PROFIT"],
    )


@router.get(
    "/orders/{order_id}/policy-snapshot",
    response_model=schemas.OrderPolicySnapshotOut,
)
def order_snapshot(
    order_id: int,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = order_policy_read_access,
) -> schemas.OrderPolicySnapshotOut:
    """订单实际应用的规则快照（BAS-06-04：可追溯）。"""
    snapshot = service.snapshot_for(db, order_id, user=user)
    return schemas.OrderPolicySnapshotOut(
        found=snapshot is not None,
        snapshot=(schemas.PolicySnapshotOut.model_validate(snapshot) if snapshot else None),
    )


__all__ = ["router"]
