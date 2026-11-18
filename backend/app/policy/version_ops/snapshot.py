"""生效版本解析与快照固化：按日期/范围取版本，深拷贝 config 避免调用方回写。"""
from __future__ import annotations

from datetime import date
from typing import Any
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import CurrentUser
from app.core.time import now_second
from app.core.errors import Validation
from app.domain.enums import PolicyScopeType, PolicyStatus
from app.domain.parties import PolicyDefinition, PolicyVersion
from app.policy._shared import _required_text, _scoped_order

def resolve_version(
    session: Session,
    *,
    policy_code: str,
    on: date,
    scope_type: str = PolicyScopeType.GLOBAL.value,
    scope_id: int | None = None,
) -> PolicyVersion | None:
    """取某日期上生效的版本。

    优先级：范围越具体越优先（USER > POOL > ORDER_TYPE > GLOBAL），
    同范围内取生效日期最新且不早于 on 的版本。
    """
    code = _required_text(
        policy_code, field="policy_code", message="policy_code 不能为空", uppercase=True
    )
    try:
        requested_scope = PolicyScopeType(
            _required_text(scope_type, field="scope_type", message="scope_type 非法", uppercase=True)
        )
    except ValueError as exc:
        raise Validation(
            f"scope_type 非法：{scope_type}",
            details={"field": "scope_type", "allowed": [s.value for s in PolicyScopeType]},
        ) from exc
    if requested_scope is PolicyScopeType.GLOBAL:
        if scope_id is not None:
            raise Validation("GLOBAL 范围不能指定 scope_id", details={"field": "scope_id"})
        scope_candidates = [(PolicyScopeType.GLOBAL.value, None, 0)]
    else:
        if scope_id is None:
            raise Validation(
                f"{requested_scope.value} 范围必须指定 scope_id",
                details={"field": "scope_id", "scope_type": requested_scope.value},
            )
        scope_candidates = [
            (requested_scope.value, scope_id, 1),
            (PolicyScopeType.GLOBAL.value, None, 0),
        ]
    definitions = session.scalars(
        select(PolicyDefinition).where(PolicyDefinition.policy_code == code)
    ).all()
    definitions_by_scope = {
        (definition.scope_type, definition.scope_id): definition
        for definition in definitions
    }
    far = date(9999, 12, 31)
    rows: list[tuple[int, PolicyVersion]] = []
    for candidate_type, candidate_id, priority in scope_candidates:
        definition = definitions_by_scope.get((candidate_type, candidate_id))
        if definition is None:
            continue
        stmt = (
            select(PolicyVersion)
            .where(PolicyVersion.policy_definition_id == definition.id)
            .where(PolicyVersion.status == PolicyStatus.ACTIVE.value)
            .where(PolicyVersion.effective_from <= on)
        )
        rows.extend(
            (priority, item)
            for item in session.scalars(stmt).all()
            if (item.effective_to or far) > on
        )
    if not rows:
        return None
    rows.sort(key=lambda item: (item[0], item[1].effective_from, item[1].version), reverse=True)
    return rows[0][1]


def make_snapshot(
    session: Session,
    *,
    policy_code: str,
    on: date,
    scope_type: str = PolicyScopeType.GLOBAL.value,
    scope_id: int | None = None,
) -> tuple[int | None, dict[str, Any] | None]:
    """生成规则快照：命中已发布版本则固化 version_id + 参数副本；未命中返回 (None, None)。

    刻意**深拷贝** config：调用方后续改动内存里的 dict 不能影响已固化的快照。
    """
    code = _required_text(
        policy_code, field="policy_code", message="policy_code 不能为空", uppercase=True
    )
    version = resolve_version(
        session,
        policy_code=code,
        on=on,
        scope_type=scope_type,
        scope_id=scope_id,
    )
    if version is None:
        return None, None
    snapshot = {
        "policy_code": code,
        "version_id": version.id,
        "version": version.version,
        "effective_from": version.effective_from.isoformat(),
        "config": dict(version.config or {}),
        "captured_at": now_second().isoformat(),
    }
    return version.id, snapshot


def snapshot_for(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> dict[str, Any] | None:
    order = _scoped_order(session, order_id, user)
    if order.policy_snapshot is None:
        return None
    return {
        "policy_version_id": order.policy_version_id,
        "policy_snapshot": order.policy_snapshot,
    }
