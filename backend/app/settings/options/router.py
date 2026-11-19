"""options.router：选项词典的只读查询 + 管理端点（D 类筛选器 / 业务字典）。

- 读取（GET）仅要求已登录：筛选器被库存/资金等页面广泛使用，不能仅限管理员。
- 写入（POST/PUT/DELETE）要求 `option-set.manage`，并写审计（entity_type=option_set）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AppError, ErrorCode, Validation
from app.shared.business_period import PERIOD_CONFIG_CODE
from app.core.security import (
    PERM_OPTION_SET_MANAGE,
    CurrentUser,
)
from app.settings.auth.session import (
    get_current_user,
    require_permissions,
)
from app.shared.audit import record_audit
from app.domain.options import OptionSet
from app.settings.options import schemas

router = APIRouter(tags=["option-sets"])

# 读端点也要走真实依赖：裸函数默认值不会被 FastAPI 解析为依赖，
# 会导致鉴权被静默跳过（user 收到函数对象本身）。
_read_access = Depends(get_current_user)
_write_access = require_permissions(PERM_OPTION_SET_MANAGE)


@router.get("/option-sets", response_model=schemas.OptionSetListOut)
def list_option_sets(
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _read_access,
    group: str | None = Query(default=None),
    editable: bool | None = Query(default=None),
) -> schemas.OptionSetListOut:
    """列出全部选项词典；可按分组 / 是否可编辑过滤。前端缓存后按 code 取用。"""
    del user
    stmt = select(OptionSet).order_by(OptionSet.group, OptionSet.code)
    if group is not None:
        stmt = stmt.where(OptionSet.group == group)
    if editable is not None:
        stmt = stmt.where(OptionSet.editable == editable)
    rows = db.scalars(stmt).all()
    return schemas.OptionSetListOut(
        items=[schemas.OptionSetOut.model_validate(row) for row in rows]
    )


@router.get("/option-sets/{code}", response_model=schemas.OptionSetOut)
def get_option_set(
    code: str,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _read_access,
) -> schemas.OptionSetOut:
    del user
    row = db.scalars(select(OptionSet).where(OptionSet.code == code)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="选项词典不存在")
    return schemas.OptionSetOut.model_validate(row)


@router.post("/option-sets", response_model=schemas.OptionSetOut, status_code=status.HTTP_201_CREATED)
def create_option_set(
    payload: schemas.OptionSetCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> schemas.OptionSetOut:
    if db.scalars(select(OptionSet).where(OptionSet.code == payload.code)).first():
        raise AppError(ErrorCode.VALIDATION_ERROR, "选项词典 code 已存在", details={"code": payload.code})
    row = OptionSet(
        code=payload.code,
        label=payload.label,
        group=payload.group,
        editable=payload.editable,
        options=[item.model_dump() for item in payload.options],
        description=payload.description,
    )
    db.add(row)
    db.flush()
    record_audit(
        db,
        action="OPTION_SET_CREATE",
        entity_type="option_set",
        entity_id=row.code,
        actor=getattr(user, "username", "system"),
        after={"label": row.label, "group": row.group, "editable": row.editable, "options": row.options},
    )
    db.commit()
    db.refresh(row)
    return schemas.OptionSetOut.model_validate(row)


@router.put("/option-sets/{code}", response_model=schemas.OptionSetOut)
def update_option_set(
    code: str,
    payload: schemas.OptionSetUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> schemas.OptionSetOut:
    row = db.scalars(select(OptionSet).where(OptionSet.code == code)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="选项词典不存在")
    if code == PERIOD_CONFIG_CODE:
        if payload.editable is not None and payload.editable:
            raise Validation("当期设置不能改为可删除选项")
        if payload.options is not None:
            options = payload.options
            if len(options) != 1 or options[0].value != "start_day" or not options[0].label.isascii() or not options[0].label.isdigit() or not 1 <= int(options[0].label) <= 31:
                raise Validation("每月起始日必须为 1 至 31 的整数")
    before = {
        "label": row.label,
        "group": row.group,
        "editable": row.editable,
        "options": row.options,
    }
    if payload.label is not None:
        row.label = payload.label
    if payload.group is not None:
        row.group = payload.group
    if payload.editable is not None:
        row.editable = payload.editable
    if payload.options is not None:
        incoming = [item.model_dump() for item in payload.options]
        if row.editable:
            # 纯字典：值与文案都可自由增删。
            row.options = incoming
        # 死枚举（editable=False）：值集合受 DB CHECK / domain/enums.py 约束，
        # 增删或改顺序会让业务语义漂移，故值序列必须逐项全等；
        # 但**展示文案允许维护**——这正是全站表格展示同步（T25）的意义所在，
        # 否则 47 项词典里只有 2 项纯字典能改文案，机制形同虚设（2026-10-26 裁决）。
        current = [{"value": opt["value"], "label": opt["label"]} for opt in (row.options or [])]
        if [opt["value"] for opt in incoming] != [opt["value"] for opt in current]:
            raise AppError(
                "该选项词典为后端死枚举：不能增删选项或调整顺序，只能修改展示文案",
                code=ErrorCode.VALIDATION_ERROR,
                details={"code": code},
            )
        blank = [opt["value"] for opt in incoming if not opt["label"].strip()]
        if blank:
            raise AppError(
                "展示文案不能为空",
                code=ErrorCode.VALIDATION_ERROR,
                details={"code": code, "values": blank},
            )
        row.options = incoming
    if payload.description is not None:
        row.description = payload.description
    record_audit(
        db,
        action="OPTION_SET_UPDATE",
        entity_type="option_set",
        entity_id=row.code,
        actor=getattr(user, "username", "system"),
        before=before,
        after={"label": row.label, "group": row.group, "editable": row.editable, "options": row.options},
    )
    db.commit()
    db.refresh(row)
    return schemas.OptionSetOut.model_validate(row)


@router.delete("/option-sets/{code}")
def delete_option_set(
    code: str,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> Response:
    if code == PERIOD_CONFIG_CODE:
        raise Validation("当期设置不可删除")
    row = db.scalars(select(OptionSet).where(OptionSet.code == code)).first()
    if row is None:
        raise HTTPException(status_code=404, detail="选项词典不存在")
    record_audit(
        db,
        action="OPTION_SET_DELETE",
        entity_type="option_set",
        entity_id=row.code,
        actor=getattr(user, "username", "system"),
        before={"label": row.label, "group": row.group, "options": row.options},
    )
    db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
