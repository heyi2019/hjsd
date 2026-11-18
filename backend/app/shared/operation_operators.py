"""业务动作操作人：统一默认当前人、多人选择、校验和更新。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import Validation
from app.core.time import now_second
from app.domain.foundation import BusinessOperationOperator
from app.domain.users import User


def validate_optional_operator_ids(
    session: Session, operator_user_ids: list[int] | None
) -> list[int] | None:
    """校验「可选」操作人：None 直接透传，提供时去重 + 在职校验。

    与 ``_resolve_operator_ids`` 的区别：本函数**不**注入默认当前人、**不**拒绝空
    列表——用于返点/流水/事件登记等「不填则沿用默认、填了才校验」的登记场景。
    空列表查询 ``in_([])`` 自然返回空集，与 ``set([])`` 相等故放行，保持既有行为。
    """
    if operator_user_ids is None:
        return None
    if len(set(operator_user_ids)) != len(operator_user_ids):
        raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
    active_ids = set(
        session.scalars(
            select(User.id).where(User.id.in_(operator_user_ids), User.is_active.is_(True))
        )
    )
    if active_ids != set(operator_user_ids):
        raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    return operator_user_ids


def _resolve_operator_ids(
    session: Session,
    *,
    actor: str,
    operator_user_ids: list[int] | None,
) -> list[int]:
    ids = list(operator_user_ids) if operator_user_ids is not None else []
    if operator_user_ids is None:
        current_id = session.scalar(
            select(User.id).where(User.username == actor, User.is_active.is_(True))
        )
        if current_id is None:
            raise Validation("当前操作人不存在或已停用", details={"field": "operator_user_ids"})
        ids = [current_id]
    if not ids:
        raise Validation("至少选择一名操作人", details={"field": "operator_user_ids"})
    if len(set(ids)) != len(ids):
        raise Validation("操作人不能重复选择", details={"field": "operator_user_ids"})
    active_ids = set(
        session.scalars(select(User.id).where(User.id.in_(ids), User.is_active.is_(True)))
    )
    if active_ids != set(ids):
        raise Validation("所选操作人不存在或已停用", details={"field": "operator_user_ids"})
    return ids


def upsert_operation_operators(
    session: Session,
    *,
    entity_type: str,
    entity_id: str | int,
    operation_key: str,
    actor: str,
    operator_user_ids: list[int] | None,
    occurred_at: datetime | None = None,
) -> BusinessOperationOperator:
    """保存一个业务动作的操作人；重复保存同一动作只更新快照。"""
    entity_type = entity_type.strip()
    entity_id = str(entity_id).strip()
    operation_key = operation_key.strip()
    if not entity_type or not entity_id or not operation_key:
        raise Validation("业务动作标识不能为空")
    ids = _resolve_operator_ids(
        session, actor=actor, operator_user_ids=operator_user_ids
    )
    row = session.scalar(
        select(BusinessOperationOperator).where(
            BusinessOperationOperator.entity_type == entity_type,
            BusinessOperationOperator.entity_id == entity_id,
            BusinessOperationOperator.operation_key == operation_key,
        )
    )
    if row is None:
        row = BusinessOperationOperator(
            entity_type=entity_type,
            entity_id=entity_id,
            operation_key=operation_key,
            operator_user_ids=ids,
            occurred_at=occurred_at or now_second(),
            created_by=actor,
            updated_by=actor,
        )
        session.add(row)
    else:
        row.operator_user_ids = ids
        row.updated_by = actor
        if occurred_at is not None:
            row.occurred_at = occurred_at
    session.flush()
    return row


def get_operation_operators(
    session: Session,
    *,
    entity_type: str,
    entity_id: str | int,
    operation_key: str,
) -> BusinessOperationOperator | None:
    return session.scalar(
        select(BusinessOperationOperator).where(
            BusinessOperationOperator.entity_type == entity_type,
            BusinessOperationOperator.entity_id == str(entity_id),
            BusinessOperationOperator.operation_key == operation_key,
        )
    )


def list_operation_operators(
    session: Session,
    *,
    entity_type: str,
    entity_id: str | int,
) -> list[BusinessOperationOperator]:
    return list(
        session.scalars(
            select(BusinessOperationOperator)
            .where(
                BusinessOperationOperator.entity_type == entity_type,
                BusinessOperationOperator.entity_id == str(entity_id),
            )
            .order_by(BusinessOperationOperator.occurred_at, BusinessOperationOperator.id)
        ).all()
    )


def list_operation_operators_bulk(
    session: Session,
    *,
    entity_type: str,
    entity_ids: list[str | int],
) -> dict[str, list[BusinessOperationOperator]]:
    """批量读取详情所需的动作操作人，避免列表页按行查询。"""
    normalized_ids = [str(entity_id).strip() for entity_id in entity_ids if str(entity_id).strip()]
    if not normalized_ids:
        return {}
    rows = session.scalars(
        select(BusinessOperationOperator)
        .where(
            BusinessOperationOperator.entity_type == entity_type,
            BusinessOperationOperator.entity_id.in_(normalized_ids),
        )
        .order_by(BusinessOperationOperator.entity_id, BusinessOperationOperator.occurred_at, BusinessOperationOperator.id)
    ).all()
    result = {entity_id: [] for entity_id in normalized_ids}
    for row in rows:
        result.setdefault(row.entity_id, []).append(row)
    return result


__all__ = [
    "get_operation_operators",
    "list_operation_operators",
    "list_operation_operators_bulk",
    "upsert_operation_operators",
]
