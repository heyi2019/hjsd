"""lists.router：列表列显示配置 API。

- 读：登录用户即可（各列表页要用它决定显示哪些列、什么顺序）；
- 写：field-definition.manage（与设置页「表单字段」同一权限，配置类动作收敛到一处）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FIELD_DEFINITION_MANAGE,
    CurrentUser,
    get_current_user,
    require_permissions,
)
from app.lists import schemas, service

router = APIRouter(tags=["lists"])

manage_list_columns = require_permissions(PERM_FIELD_DEFINITION_MANAGE)


@router.get("/list-columns", response_model=list[schemas.ListScopeOut])
def list_column_configs(
    db: Session = Depends(get_db),
    _user: CurrentUser = Depends(get_current_user),
) -> list[schemas.ListScopeOut]:
    """全部列表的列清单与当前显示配置（列名以服务端注册表为准）。"""
    return [schemas.ListScopeOut.model_validate(item) for item in service.list_configs(db)]


@router.get("/list-columns/custom-fields", response_model=list[schemas.CustomFieldOptionOut])
def list_custom_field_options(
    db: Session = Depends(get_db),
    _user: CurrentUser = Depends(get_current_user),
) -> list[schemas.CustomFieldOptionOut]:
    """可新增为自定义列的候选：全部启用的表单自定义字段（按作用域分组）。"""
    return [
        schemas.CustomFieldOptionOut.model_validate(item)
        for item in service.list_custom_field_options(db)
    ]


@router.post("/list-columns/{scope}/custom", response_model=schemas.ListScopeOut)
def add_custom_column(
    scope: str,
    payload: schemas.ListCustomColumnCreate,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_list_columns,
) -> schemas.ListScopeOut:
    """为某列表新增一列（绑定表单自定义字段）；重复列返回 409。"""
    result = service.add_custom_column(
        db,
        scope,
        field_key=payload.field_key,
        label=payload.label,
        actor=_user.username,
    )
    return schemas.ListScopeOut.model_validate(result)


@router.delete("/list-columns/{scope}/custom/{column_key}", response_model=schemas.ListScopeOut)
def remove_custom_column(
    scope: str,
    column_key: str,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_list_columns,
) -> schemas.ListScopeOut:
    """删除自定义列定义及其显示配置；内置列不受影响。"""
    result = service.remove_custom_column(db, scope, column_key, actor=_user.username)
    return schemas.ListScopeOut.model_validate(result)


@router.put("/list-columns/{scope}", response_model=schemas.ListScopeOut)
def save_column_config(
    scope: str,
    payload: schemas.ListColumnSave,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_list_columns,
) -> schemas.ListScopeOut:
    """整表保存某列表的列显示与顺序；锁定列不可隐藏，越界或未知列返回 422。"""
    result = service.save_config(
        db,
        scope,
        [item.model_dump() for item in payload.items],
        actor=_user.username,
    )
    return schemas.ListScopeOut.model_validate(result)


@router.delete("/list-columns/{scope}", response_model=schemas.ListScopeOut)
def reset_column_config(
    scope: str,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_list_columns,
) -> schemas.ListScopeOut:
    """恢复默认：清空该列表的显示配置，回到注册表顺序与全列可见（自定义列定义保留）。"""
    result = service.reset_config(db, scope, actor=_user.username)
    return schemas.ListScopeOut.model_validate(result)
