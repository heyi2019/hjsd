"""orders.form_fields_router：建单表单字段配置 API（设置页「表单」）。

端点只围绕 `OrderFormField` 定义与板块标题（含核心字段锁定）做增删改查，
与订单交易主流程无耦合，故从 orders.router 独立出来。

规则来源：BAS-04 表单扩展字段、ORD-01 建单表单。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import (
    PERM_FIELD_DEFINITION_MANAGE,
    CurrentUser,
)
from app.settings.auth.session import (
    get_current_user,
    require_permissions,
)
from . import schemas

router = APIRouter(tags=["ORD-01/02 建单表单配置"])

# 读写分权（2026-11-05 修正）：字段定义与板块标题是**表单渲染元数据**，建单、库存、
# 客户、分期、返点、资金等几乎所有业务表单挂载时都要读它（FieldConfigScope /
# useOrderFormConfig / useOrderFormSectionLabels）。
# 原先把三个 GET 也挂在 field-definition.manage 上，导致 OPERATOR / FINANCE / AUDITOR
# 全部 403；前端 catch 后降级为空配置且不报错，表现为「管理员配好的自定义字段与
# 板块标题对非管理员彻底失效」，只有控制台两行 403 可见，极易漏判。
# 口径与 options / lists 两个 router 一致：读=登录即可，写=field-definition.manage。
read_form_config = Depends(get_current_user)
manage_form_fields = require_permissions(PERM_FIELD_DEFINITION_MANAGE)

@router.get(
    "/order-form-fields/scopes",
    response_model=list[schemas.FormScopeOut],
)
def list_form_scopes(
    _user: CurrentUser = read_form_config,
) -> list[schemas.FormScopeOut]:
    """表单作用域注册表：设置页「表单」下拉的单一事实源。"""
    from app.domain.form_scopes import list_scopes

    return [schemas.FormScopeOut.model_validate(item) for item in list_scopes()]


@router.get(
    "/order-form-fields",
    response_model=list[schemas.OrderFormFieldOut],
)
def list_order_form_fields(
    order_type_code: str,
    include_inactive: bool = True,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_form_config,
) -> list[schemas.OrderFormFieldOut]:
    """按业务类型 code 列出建单表单字段配置（含停用项）。"""
    from app.business.shared.form_config import form_fields as ff

    return [
        schemas.OrderFormFieldOut.model_validate(f)
        for f in ff.list_order_form_fields(
            db, order_type_code=order_type_code, include_inactive=include_inactive
        )
    ]


@router.get(
    "/order-form-fields/section-labels",
    response_model=dict[str, str],
)
def list_section_labels(
    order_type_code: str,
    db: Session = Depends(get_db),
    _user: CurrentUser = read_form_config,
) -> dict[str, str]:
    """按业务类型返回板块键→显示标题映射（设置面板与建单表单共用的板块标题来源）。"""
    from app.business.shared.form_config import form_fields as ff

    return ff.get_section_labels(db, order_type_code=order_type_code)


@router.put(
    "/order-form-fields/section-labels",
    response_model=dict[str, str],
)
def save_section_labels(
    payload: schemas.SectionLabelsSaveIn,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> dict[str, str]:
    """覆盖保存某业务类型的板块标题（按板块键 upsert）。板块键须合法、作用域须已注册。"""
    from app.business.shared.form_config import form_fields as ff

    return ff.save_section_labels(
        db, order_type_code=payload.order_type_code, labels=payload.labels, actor=_user.username
    )


@router.post("/order-form-fields/section-labels/rename", response_model=dict[str, str])
def rename_form_section(
    payload: schemas.SectionRenameIn,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> dict[str, str]:
    from app.business.shared.form_config import form_fields as ff

    return ff.rename_form_section(
        db, order_type_code=payload.order_type_code, from_key=payload.from_key,
        to_key=payload.to_key, label=payload.label, actor=_user.username,
    )


@router.post(
    "/order-form-fields",
    response_model=schemas.OrderFormFieldOut,
    status_code=201,
)
def create_order_form_field(
    payload: schemas.OrderFormFieldCreate,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> schemas.OrderFormFieldOut:
    """新增自定义建单表单字段。"""
    from app.business.shared.form_config import form_fields as ff

    return schemas.OrderFormFieldOut.model_validate(
        ff.create_order_form_field(
            db,
            order_type_code=payload.order_type_code,
            field_key=payload.field_key,
            label=payload.label,
            actor=_user.username,
            field_type=payload.field_type,
            options=[item.model_dump() for item in payload.options] if payload.options is not None else None,
            flow_direction=payload.flow_direction if payload.flow_direction else None,
            required=payload.required,
            required_when=(
                payload.required_when.model_dump() if payload.required_when is not None else None
            ),
            is_active=payload.is_active,
            sort_order=payload.sort_order,
            section=payload.section,
            note=payload.note,
        )
    )


@router.patch(
    "/order-form-fields/{field_id}",
    response_model=schemas.OrderFormFieldOut,
)
def update_order_form_field(
    field_id: int,
    payload: schemas.OrderFormFieldUpdate,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> schemas.OrderFormFieldOut:
    """编辑建单表单字段（label/类型/选项/必填态/排序/备注）。"""
    from app.business.shared.form_config import form_fields as ff

    extra: dict[str, object] = {}
    # required_when 三态：未传=保持不变；显式 null=清除条件；对象=设为条件必填。
    if "required_when" in payload.model_fields_set:
        extra["required_when"] = (
            payload.required_when.model_dump() if payload.required_when is not None else None
        )
    if "flow_direction" in payload.model_fields_set:
        extra["flow_direction"] = payload.flow_direction if payload.flow_direction else None
    if "note" in payload.model_fields_set:
        extra["note"] = payload.note
    if "expected_options" in payload.model_fields_set:
        extra["expected_options"] = [item.model_dump() for item in (payload.expected_options or [])]

    return schemas.OrderFormFieldOut.model_validate(
        ff.update_order_form_field(
            db,
            field_id,
            actor=_user.username,
            label=payload.label,
            field_type=payload.field_type,
            options=[item.model_dump() for item in payload.options] if payload.options is not None else None,
            required=payload.required,
            sort_order=payload.sort_order,
            section=payload.section,
            **extra,
        )
    )


@router.patch(
    "/order-form-fields/{field_id}/active",
    response_model=schemas.OrderFormFieldOut,
)
def set_order_form_field_active(
    field_id: int,
    active: bool,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> schemas.OrderFormFieldOut:
    """启用/停用建单表单字段（核心字段亦允许，由前端提示风险）。"""
    from app.business.shared.form_config import form_fields as ff

    return schemas.OrderFormFieldOut.model_validate(
        ff.set_order_form_field_active(db, field_id, active, actor=_user.username)
    )


@router.delete(
    "/order-form-fields/{field_id}",
    status_code=204,
    response_model=None,
)
def delete_order_form_field(
    field_id: int,
    db: Session = Depends(get_db),
    _user: CurrentUser = manage_form_fields,
) -> None:
    """删除建单表单字段：核心字段(locked)禁止删除。"""
    from app.business.shared.form_config import form_fields as ff

    ff.delete_order_form_field(db, field_id, actor=_user.username)


__all__ = ["router"]
