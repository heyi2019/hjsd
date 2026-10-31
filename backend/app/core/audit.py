"""core.audit：受控动作审计写入（BAS-05-03）。

凡是接触联系方式、资金、合并、规则、字段定义、事件与冲销的动作，
必须在**同一事务**里调用 `record_audit`，保证业务与审计同生共死。
"""
from __future__ import annotations

from typing import Any, Mapping

from sqlalchemy.orm import Session

from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog
from app.core.request_context import get_request_id
from app.core.time import now_second

DEFAULT_ACTOR = "system"


def record_audit(
    session: Session,
    *,
    action: AuditAction | str,
    entity_type: str,
    entity_id: str | int | None = None,
    actor: str | None = None,
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
    reason: str | None = None,
    request_id: str | None = None,
) -> AuditLog:
    """写一条审计日志（只追加，不可修改或删除）。"""
    entry = AuditLog(
        actor=actor or DEFAULT_ACTOR,
        action=action.value if isinstance(action, AuditAction) else action,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else "",
        before_json=dict(before) if before else None,
        after_json=dict(after) if after else None,
        reason=reason,
        request_id=request_id or get_request_id(),
        # 显式写本地时间：原 server_default=func.now() 是 UTC，与查询端本地日期边界错位
        # （本地凌晨运行时记录落在 UTC 昨日，按本地“今天”过滤会漏掉）。审计按本地工作日历查，
        # 故落库即固化为本地时间，保证“今天发生的事”能被“今天”过滤命中。
        occurred_at=now_second(),
    )
    session.add(entry)
    session.flush()
    return entry


__all__ = ["DEFAULT_ACTOR", "record_audit"]
