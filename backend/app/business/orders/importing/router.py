"""订单导入模板和只读预检。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser, PERM_ORDER_CREATE
from app.domain.foundation import Pool
from app.domain.users import User
from app.settings.auth.session import require_permissions
from app.settings.lists.file_response import XLSX_MEDIA_TYPE, file_response
from app.settings.lists.service import get_config

from .parser import MAX_FILE_BYTES, parse_order_import
from .custom_columns import configured_order_columns
from .execute import execute_order_import
from .preview import preview_order_import
from .schemas import ImportPreviewOut, ImportResultOut
from .template import build_order_import_template

router = APIRouter(prefix="/order-imports", tags=["订单导入"])
_create_orders = require_permissions(PERM_ORDER_CREATE)


@router.get("/template.xlsx")
def order_import_template(
    sections: list[str] = Query(default=[]),
    db: Session = Depends(get_db),
    _user: CurrentUser = _create_orders,
):
    config = get_config(db, "LEDGER")
    pools = db.scalars(select(Pool).where(Pool.status == "ACTIVE").order_by(Pool.code)).all()
    users = db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.username)).all()
    custom_choices: dict[str, list[str]] = {}
    for (_, label), configured in configured_order_columns(db).items():
        if configured is None:
            continue
        column, definition = configured
        if definition.field_type == "SELECT" and isinstance(column.value_labels, dict):
            custom_choices.setdefault(label, []).extend(str(value) for value in column.value_labels)
        elif definition.field_type == "BOOLEAN":
            custom_choices[label] = ["是", "否"]
    content = build_order_import_template(
        config["columns"], set(sections),
        pool_codes=[pool.code for pool in pools if _user.can_see_pool(pool.id)],
        operators=[user.username for user in users],
        custom_choices=custom_choices,
    )
    return file_response(content, "订单导入模板.xlsx", XLSX_MEDIA_TYPE)


@router.post("/preview", response_model=ImportPreviewOut, response_model_exclude_none=True)
async def order_import_preview(
    file: UploadFile = File(...),
    existing: Literal["skip", "update"] = Form(...),
    sections: list[str] = Form(default=[]),
    db: Session = Depends(get_db),
    user: CurrentUser = _create_orders,
):
    try:
        content = await file.read(MAX_FILE_BYTES + 1)
        return await run_in_threadpool(
            lambda: preview_order_import(db, parse_order_import(file.filename or "", content), existing=existing, sections=set(sections), user=user)
        )
    finally:
        await file.close()


@router.post("/execute", response_model=ImportResultOut)
async def order_import_execute(
    file: UploadFile = File(...),
    existing: Literal["skip", "update"] = Form(...),
    sections: list[str] = Form(default=[]),
    db: Session = Depends(get_db),
    user: CurrentUser = _create_orders,
):
    try:
        content = await file.read(MAX_FILE_BYTES + 1)
        return await run_in_threadpool(
            lambda: execute_order_import(db, parse_order_import(file.filename or "", content), existing=existing, sections=set(sections), user=user)
        )
    finally:
        await file.close()
