"""表单字段依赖护栏与系统术语字段锁定。"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.domain.trade import OrderFormField

# 系统统一术语字段：显示名由业务口径固定（如 payment_pool_id 全站统一「资金账户」），
# 配置中心只读展示；此集合是最终裁决，防止绕过界面直接调接口改名。
FIXED_LABEL_FIELD_KEYS = frozenset({"payment_pool_id"})

def _dependent_field_labels(session: Session, definition: OrderFormField) -> list[str]:
    """返回把该字段作为条件依赖的其它字段标签（同作用域；条件只允许同作用域引用）。

    停用/删除被依赖的字段会让下游条件必填永久无法命中（依赖值恒空），
    表现为「设置页显示条件必填、表单却永不转必填」的静默失效，故两处均需拦截。
    """
    rows = session.scalars(
        select(OrderFormField).where(
            OrderFormField.order_type_code == definition.order_type_code,
            OrderFormField.id != definition.id,
        )
    )
    labels: list[str] = []
    for row in rows:
        condition = row.required_when
        if isinstance(condition, dict) and condition.get("field") == definition.field_key:
            labels.append(row.label)
    return sorted(labels)


def _reject_if_dependent(
    session: Session, definition: OrderFormField, *, action: str
) -> None:
    dependents = _dependent_field_labels(session, definition)
    if not dependents:
        return
    joined = "、".join(f"「{label}」" for label in dependents)
    raise Validation(
        f"字段「{definition.label}」被 {len(dependents)} 个条件必填引用（{joined}），"
        f"无法{action}；请先解除这些字段的条件必填",
        details={
            "field_key": definition.field_key,
            "order_type_code": definition.order_type_code,
            "dependents": dependents,
        },
    )
