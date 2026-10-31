"""policy.definitions：规则定义（PolicyDefinition）的建档与查询（BAS-06-01）。
"""

from __future__ import annotations

from typing import Any
from app.core.audit import record_audit
from app.domain.users import User
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.errors import (
    NotFound,
    Validation,
)
from app.domain.enums import (
    AuditAction,
    PolicyScopeType,
    PolicyStatus,
)
from app.domain.parties import PolicyDefinition
from app.domain.foundation import (
    OrderTypeDef,
    Pool,
)

from ._shared import (
    _def_out,
    _required_text,
)

def list_definitions(
    session: Session,
    *,
    status: str | None = None,
    policy_code: str | None = None,
) -> list[dict[str, Any]]:
    stmt = select(PolicyDefinition).order_by(PolicyDefinition.id)
    if status:
        stmt = stmt.where(PolicyDefinition.status == status.upper())
    if policy_code:
        stmt = stmt.where(PolicyDefinition.policy_code == policy_code.upper())
    return [_def_out(item) for item in session.scalars(stmt).all()]


def get_definition(session: Session, definition_id: int) -> dict[str, Any]:
    item = session.get(PolicyDefinition, definition_id)
    if item is None:
        raise NotFound(f"规则 {definition_id} 不存在", details={"definition_id": definition_id})
    return _def_out(item)


def create_definition(
    session: Session,
    *,
    policy_code: str,
    name: str,
    scope_type: str,
    scope_id: int | None = None,
    description: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    code = _required_text(
        policy_code, field="policy_code", message="policy_code 不能为空", uppercase=True
    )
    label = _required_text(name, field="name", message="name 不能为空")
    try:
        scope = PolicyScopeType(
            _required_text(scope_type, field="scope_type", message="scope_type 非法", uppercase=True)
        )
    except ValueError as exc:
        raise Validation(
            f"scope_type 非法：{scope_type}",
            details={"field": "scope_type", "allowed": [s.value for s in PolicyScopeType]},
        ) from exc
    if scope_id is not None and (isinstance(scope_id, bool) or not isinstance(scope_id, int) or scope_id <= 0):
        raise Validation(
            "scope_id 必须为正整数",
            details={"field": "scope_id", "value": scope_id},
        )
    if scope is PolicyScopeType.GLOBAL and scope_id is not None:
        raise Validation(
            "GLOBAL 范围不能指定 scope_id",
            details={"field": "scope_id", "scope_type": scope.value},
        )
    # 非全局范围必须指定 scope_id，否则规则会误伤全部业务
    if scope is not PolicyScopeType.GLOBAL and scope_id is None:
        raise Validation(
            f"{scope.value} 范围必须指定 scope_id",
            details={"field": "scope_id", "scope_type": scope.value},
        )
    target_models = {
        PolicyScopeType.ORDER_TYPE: OrderTypeDef,
        PolicyScopeType.USER: User,
        PolicyScopeType.POOL: Pool,
    }
    target_model = target_models.get(scope)
    if target_model is not None and session.get(target_model, scope_id) is None:
        raise Validation(
            f"{scope.value} 关联对象不存在",
            details={"field": "scope_id", "scope_type": scope.value, "scope_id": scope_id},
        )

    exists = session.scalar(
        select(PolicyDefinition.id)
        .where(PolicyDefinition.policy_code == code)
        .where(PolicyDefinition.scope_type == scope.value)
        .where(
            PolicyDefinition.scope_id.is_(None)
            if scope_id is None
            else PolicyDefinition.scope_id == scope_id
        )
    )
    if exists:
        raise Validation(
            f"同一适用范围的规则编码已存在：{code}",
            details={"policy_code": code, "scope_type": scope.value, "scope_id": scope_id, "id": exists},
        )

    item = PolicyDefinition(
        policy_code=code,
        name=label,
        scope_type=scope.value,
        scope_id=scope_id,
        description=description,
        status=PolicyStatus.DRAFT.value,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.POLICY_CHANGE,
        entity_type="policy_definition",
        entity_id=item.id,
        actor=actor,
        after=_def_out(item),
    )
    return _def_out(item)


# ── T19 / BAS-06-02：版本 + 生效期 + 审批 ────────────────────────
