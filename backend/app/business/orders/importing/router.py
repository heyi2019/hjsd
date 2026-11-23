"""订单导入模板和只读预检。"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import CurrentUser, PERM_ORDER_CREATE
from app.settings.auth.session import require_permissions
from app.settings.lists.file_response import XLSX_MEDIA_TYPE, file_response
from app.settings.lists.service import get_config

from .parser import MAX_FILE_BYTES, parse_order_import
from .execute import execute_order_import
from .preview import preview_order_import
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
    content = build_order_import_template(config["columns"], set(sections))
    return file_response(content, "订单导入模板.xlsx", XLSX_MEDIA_TYPE)


@router.post("/preview")
async def order_import_preview(
    file: UploadFile = File(...),
    existing: Literal["skip", "update"] = Form(...),
    sections: list[str] = Form(default=[]),
    db: Session = Depends(get_db),
    user: CurrentUser = _create_orders,
):
    try:
        content = await file.read(MAX_FILE_BYTES + 1)
        tables = parse_order_import(file.filename or "", content)
        return preview_order_import(db, tables, existing=existing, sections=set(sections), user=user)
    finally:
        await file.close()


@router.post("/execute")
async def order_import_execute(
    file: UploadFile = File(...),
    existing: Literal["skip", "update"] = Form(...),
    sections: list[str] = Form(default=[]),
    db: Session = Depends(get_db),
    user: CurrentUser = _create_orders,
):
    try:
        content = await file.read(MAX_FILE_BYTES + 1)
        tables = parse_order_import(file.filename or "", content)
        return execute_order_import(db, tables, existing=existing, sections=set(sections), user=user)
    finally:
        await file.close()
