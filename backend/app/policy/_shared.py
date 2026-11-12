"""policy._shared：规则定义 / 版本 / 分配共用的文本校验、订单范围与输出序列化。
"""

from __future__ import annotations

from typing import Any
from app.core.security import CurrentUser
from sqlalchemy.orm import Session
from app.core.errors import Validation
from app.domain.parties import (
    PolicyDefinition,
    PolicyVersion,
)
from app.domain.trade import Order

def _required_text(
    value: Any, *, field: str, message: str, uppercase: bool = False
) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Validation(message, details={"field": field})
    text = value.strip()
    return text.upper() if uppercase else text


def _scoped_order(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> Order:
    """策略相关订单读写必须复用订单统一的负责人范围规则。"""
    from app.orders._shared import get_order

    return get_order(session, order_id, user)


def _def_out(item: PolicyDefinition) -> dict[str, Any]:
    return {
        "id": item.id,
        "policy_code": item.policy_code,
        "name": item.name,
        "scope_type": item.scope_type,
        "scope_id": item.scope_id,
        "description": item.description,
        "status": item.status,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


def _ver_out(item: PolicyVersion) -> dict[str, Any]:
    return {
        "id": item.id,
        "policy_definition_id": item.policy_definition_id,
        "version": item.version,
        "effective_from": item.effective_from.isoformat() if item.effective_from else None,
        "effective_to": item.effective_to.isoformat() if item.effective_to else None,
        "config": item.config,
        "status": item.status,
        "approved_by": item.approved_by,
        "approved_at": item.approved_at.isoformat() if item.approved_at else None,
        "note": item.note,
    }


def _normalize_policy_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise Validation("规则参数必须为对象", details={"field": "config"})
    if not config:
        raise Validation("规则参数不能为空", details={"field": "config"})
    return dict(config)


# ── T19 / BAS-06-01：规则定义 ───────────────────────────────────
