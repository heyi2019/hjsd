"""options.router：选项词典的只读查询 + 管理端点（D 类筛选器 / 业务字典）。

- 读取（GET）仅要求已登录：筛选器被库存/资金等页面广泛使用，不能仅限管理员。
- 写入（POST/PUT/DELETE）要求 `option-set.manage`，并写审计（entity_type=option_set）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import AppError, ErrorCode, Validation
from app.shared.business_period import PERIOD_CONFIG_CODE
from app.business.profit_allocation.company_settings import COMPANY_PROFIT_CODE
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
from app.shared.option_codes import allocate_option_code
from app.shared.option_archive import archive_option_items
from app.settings.field_definitions.catalog_seed import accounting_attribute_options, builtin_option_set_policy
from app.settings.options import schemas
from app.workbench.reminder_config import REMINDER_CODE, validate_reminder_options

router = APIRouter(tags=["option-sets"])

# 读端点也要走真实依赖：裸函数默认值不会被 FastAPI 解析为依赖，
# 会导致鉴权被静默跳过（user 收到函数对象本身）。
_read_access = Depends(get_current_user)
_write_access = require_permissions(PERM_OPTION_SET_MANAGE)

SPECIAL_OPTION_BEHAVIORS = {
    ("CUSTOMER_SOURCE", "其他"): "OTHER",
    ("SUPPLIER_SOURCE", "其他"): "OTHER",
    ("INTERMEDIARY_PLATFORM", "其他"): "OTHER",
    ("INTERMEDIARY_TYPE", "包赔"): "COMPENSATION",
}
MANAGED_OPTION_CODES = frozenset({
    "CUSTOMER_SOURCE", "SUPPLIER_SOURCE", "INTERMEDIARY_PLATFORM", "INTERMEDIARY_TYPE",
    "COMPENSATION_TYPE", "STUDIO_EXPENSE_ITEM",
})


def _output(row: OptionSet) -> schemas.OptionSetOut:
    result = schemas.OptionSetOut.model_validate(row)
    if row.code == "FUND_FLOW_ACCOUNTING_ATTRIBUTE":
        return result.model_copy(update={
            "editable": False,
            "options": [schemas.OptionItem(**item) for item in accounting_attribute_options()],
        })
    _, fixed = builtin_option_set_policy()
    return result.model_copy(update={"editable": False}) if row.code in fixed else result


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
        _, fixed = builtin_option_set_policy()
        if editable:
            stmt = stmt.where(OptionSet.editable.is_(True), OptionSet.code.not_in(fixed))
        else:
            stmt = stmt.where(or_(OptionSet.editable.is_(False), OptionSet.code.in_(fixed)))
    rows = db.scalars(stmt).all()
    return schemas.OptionSetListOut(
        items=[_output(row) for row in rows]
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
    return _output(row)


@router.post("/option-sets", response_model=schemas.OptionSetOut, status_code=status.HTTP_201_CREATED)
def create_option_set(
    payload: schemas.OptionSetCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> schemas.OptionSetOut:
    if payload.code == COMPANY_PROFIT_CODE:
        raise Validation("请通过公司分润设置修改")
    if payload.code == REMINDER_CODE:
        validate_reminder_options([item.model_dump() for item in payload.options])
    if db.scalars(select(OptionSet).where(OptionSet.code == payload.code)).first():
        raise Validation("选项词典 code 已存在", code=ErrorCode.DUPLICATE_CODE, details={"code": payload.code})
    _, fixed = builtin_option_set_policy()
    if payload.code in fixed:
        raise Validation("系统固定词典由初始化程序维护，不能自行创建", details={"code": payload.code})
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
    return _output(row)


@router.put("/option-sets/{code}", response_model=schemas.OptionSetOut)
def update_option_set(
    code: str,
    payload: schemas.OptionSetUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> schemas.OptionSetOut:
    if code == COMPANY_PROFIT_CODE:
        raise Validation("请通过公司分润设置修改")
    row = db.scalars(select(OptionSet).where(OptionSet.code == code).with_for_update()).first()
    if row is None:
        raise HTTPException(status_code=404, detail="选项词典不存在")
    _, fixed = builtin_option_set_policy()
    fixed_values = code in fixed
    if fixed_values and payload.editable:
        raise Validation("系统固定词典不能改为可增删选项", details={"code": code})
    if code == PERIOD_CONFIG_CODE:
        if payload.editable is not None and payload.editable:
            raise Validation("当期设置不能改为可删除选项")
        if payload.options is not None:
            options = payload.options
            if len(options) != 1 or options[0].value != "start_day" or not options[0].label.isascii() or not options[0].label.isdigit() or not 1 <= int(options[0].label) <= 31:
                raise Validation("每月起始日必须为 1 至 31 的整数")
    if code == REMINDER_CODE and payload.options is not None:
        validate_reminder_options([item.model_dump() for item in payload.options])
    if code == "FUND_FLOW_ACCOUNTING_ATTRIBUTE" and payload.options is not None:
        if [item.model_dump() for item in payload.options] != accounting_attribute_options():
            raise Validation("核算属性取值与名称由系统统一维护")
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
    if fixed_values:
        row.editable = False
    elif payload.editable is not None:
        row.editable = payload.editable
    if payload.options is not None:
        incoming = [item.model_dump() for item in payload.options]
        if code in MANAGED_OPTION_CODES:
            previous = {item["value"]: item for item in row.options or []}
            if any(item["value"] not in previous for item in incoming):
                raise Validation("字典项编码不可修改，新增选项请使用新增接口")
            if any(item.get("behavior") != previous[item["value"]].get("behavior") for item in incoming):
                raise Validation("字典项业务含义不可修改")
            if len({item["value"] for item in incoming}) != len(incoming) or len({item["label"] for item in incoming}) != len(incoming):
                raise Validation("字典项编码和名称不能重复")
        if row.editable:
            kept = {item["value"] for item in incoming}
            removed = [item for item in row.options or [] if item.get("value") not in kept]
            archive_option_items(db, code, removed, actor=getattr(user, "username", "system"))
            row.options = incoming
        # 死枚举（editable=False）：值集合受 DB CHECK / domain/enums.py 约束，
        # 增删或改顺序会让业务语义漂移，故值序列必须逐项全等；
        # 但**展示文案允许维护**——这正是全站表格展示同步（T25）的意义所在，
        # 否则 47 项词典里只有 2 项纯字典能改文案，机制形同虚设（2026-10-26 裁决）。
        current = accounting_attribute_options() if code == "FUND_FLOW_ACCOUNTING_ATTRIBUTE" else [
            {"value": opt["value"], "label": opt["label"]} for opt in (row.options or [])
        ]
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
    return _output(row)


@router.post("/option-sets/{code}/items", response_model=schemas.OptionSetOut, status_code=status.HTTP_201_CREATED)
def create_option_item(
    code: str,
    payload: schemas.OptionItemCreate,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> schemas.OptionSetOut:
    row = db.scalar(select(OptionSet).where(OptionSet.code == code).with_for_update())
    if row is None:
        raise HTTPException(status_code=404, detail="选项词典不存在")
    _, fixed = builtin_option_set_policy()
    if not row.editable or code in fixed or code in {COMPANY_PROFIT_CODE, PERIOD_CONFIG_CODE, REMINDER_CODE}:
        raise Validation("该配置不支持新增字典项", details={"code": code})
    options = list(row.options or [])
    if any(str(item.get("label", "")).strip() == payload.label for item in options):
        raise Validation("字典项名称已存在", code=ErrorCode.DUPLICATE_CODE, details={"label": payload.label})
    if payload.label in {"有", "对", "是"}:
        value = "Y"
    elif payload.label in {"无", "否", "不"}:
        value = "N"
    else:
        try:
            value = allocate_option_code(db, f"option-set:{code}", code, [str(item.get("value", "")) for item in options])
        except ValueError as exc:
            raise Validation("字典编码无法生成选项编码", details={"code": code}) from exc
    if any(item.get("value") == value for item in options):
        raise Validation("该字典已有相同含义的选项", code=ErrorCode.DUPLICATE_CODE, details={"value": value})
    before = [dict(item) for item in options]
    new_option = {"value": value, "label": payload.label}
    behavior = SPECIAL_OPTION_BEHAVIORS.get((code, payload.label))
    if behavior:
        if any(item.get("behavior") == behavior for item in options):
            raise Validation("该字典已有相同业务含义的选项", details={"behavior": behavior})
        new_option["behavior"] = behavior
    row.options = [*options, new_option]
    record_audit(db, action="OPTION_SET_UPDATE", entity_type="option_set", entity_id=row.code,
                 actor=getattr(user, "username", "system"), before={"options": before}, after={"options": row.options})
    db.commit()
    db.refresh(row)
    return _output(row)


@router.delete("/option-sets/{code}")
def delete_option_set(
    code: str,
    db: Annotated[Session, Depends(get_db)],
    user: CurrentUser = _write_access,
) -> Response:
    if code == COMPANY_PROFIT_CODE:
        raise Validation("公司分润设置不可删除")
    if code == PERIOD_CONFIG_CODE:
        raise Validation("当期设置不可删除")
    row = db.scalars(select(OptionSet).where(OptionSet.code == code).with_for_update()).first()
    if row is None:
        raise HTTPException(status_code=404, detail="选项词典不存在")
    builtins, _ = builtin_option_set_policy()
    if code in builtins:
        raise Validation("系统内置词典不可删除", details={"code": code})
    archive_option_items(db, code, list(row.options or []), actor=getattr(user, "username", "system"))
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
