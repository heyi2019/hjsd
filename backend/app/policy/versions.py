"""policy.versions：规则版本、生效期、审批与生效版本解析（BAS-06-02）。

红线：已被引用的版本不可修改/删除；同范围新版本不得与已有版本有效期重叠；
已发生的业务不因规则改版而变化（`resolve_version` + `policy_snapshot` 固化）。
有效期模型 `[effective_from, effective_to)` 左闭右开，NULL 表示至今。
"""

from __future__ import annotations

from datetime import date
from datetime import datetime
from typing import Any
from app.core.audit import record_audit
from app.core.security import CurrentUser
from sqlalchemy import (
    func,
    select,
)
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
from app.domain.parties import (
    PolicyDefinition,
    PolicyVersion,
)

from ._shared import (
    _normalize_policy_config,
    _required_text,
    _scoped_order,
    _ver_out,
)

def _overlaps(
    session: Session,
    definition_id: int,
    start: date,
    end: date | None,
    *,
    exclude_version_id: int | None = None,
) -> PolicyVersion | None:
    """找出与 [start, end) 重叠的已有版本。

    区间重叠判定：a.start < b.end AND b.start < a.end；
    NULL 结束日视为至今（用极大值代替）。
    """
    far = date(9999, 12, 31)
    stmt = select(PolicyVersion).where(PolicyVersion.policy_definition_id == definition_id)
    if exclude_version_id is not None:
        stmt = stmt.where(PolicyVersion.id != exclude_version_id)
    for item in session.scalars(stmt).all():
        other_start = item.effective_from
        other_end = item.effective_to or far
        if start < other_end and other_start < (end or far):
            return item
    return None


def list_versions(
    session: Session, definition_id: int, *, status: str | None = None
) -> list[dict[str, Any]]:
    if session.get(PolicyDefinition, definition_id) is None:
        raise NotFound(f"规则 {definition_id} 不存在", details={"definition_id": definition_id})
    stmt = select(PolicyVersion).where(PolicyVersion.policy_definition_id == definition_id)
    if status:
        stmt = stmt.where(PolicyVersion.status == status.upper())
    stmt = stmt.order_by(PolicyVersion.version.desc())
    return [_ver_out(item) for item in session.scalars(stmt).all()]


def create_version(
    session: Session,
    definition_id: int,
    *,
    effective_from: date,
    effective_to: date | None = None,
    config: dict[str, Any],
    note: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    """新建版本。**不修改已有版本** —— 已发布版本不可变（BAS-06-02）。"""
    definition = session.get(PolicyDefinition, definition_id)
    if definition is None:
        raise NotFound(f"规则 {definition_id} 不存在", details={"definition_id": definition_id})
    normalized_config = _normalize_policy_config(config)
    if effective_to is not None and effective_to <= effective_from:
        raise Validation(
            "失效日期必须晚于生效日期",
            details={"effective_from": str(effective_from), "effective_to": str(effective_to)},
        )

    conflict = _overlaps(session, definition_id, effective_from, effective_to)
    if conflict is not None:
        if (
            conflict.effective_to is None
            and conflict.effective_from < effective_from
            and (effective_to is None or conflict.effective_from < effective_to)
        ):
            # 「开放至今」的旧版本由新版本接续封口（旧失效日 = 新生效日）：
            # 否则开放版本一旦存在，任何新版本都建不出来，规则永远无法改版。
            # 只调整生效窗口，不改旧版本 config（口径仍不可变）。
            conflict.effective_to = effective_from
            session.add(conflict)
            session.flush()
        else:
            raise Validation(
                "生效期与已有版本重叠",
                details={
                    "conflict_version": conflict.version,
                    "conflict_from": conflict.effective_from.isoformat(),
                    "conflict_to": conflict.effective_to.isoformat() if conflict.effective_to else None,
                },
            )

    next_version = int(
        session.scalar(
            select(func.coalesce(func.max(PolicyVersion.version), 0)).where(
                PolicyVersion.policy_definition_id == definition_id
            )
        )
        or 0
    ) + 1
    item = PolicyVersion(
        policy_definition_id=definition_id,
        version=next_version,
        effective_from=effective_from,
        effective_to=effective_to,
        config=normalized_config,
        status=PolicyStatus.ACTIVE.value,
        note=note,
        approved_by=actor,
        created_by=actor,
        updated_by=actor,
    )
    session.add(item)
    session.flush()
    record_audit(
        session,
        action=AuditAction.POLICY_CHANGE,
        entity_type="policy_version",
        entity_id=item.id,
        actor=actor,
        after=_ver_out(item),
    )
    return _ver_out(item)




def update_version_draft(
    session: Session, version_id: int, *, config: dict[str, Any], actor: str = "system"
) -> dict[str, Any]:
    """只允许改**未发布**的草稿版本。已发布版本一律拒绝（BAS-06-02）。"""
    item = session.get(PolicyVersion, version_id)
    if item is None:
        raise NotFound(f"规则版本 {version_id} 不存在", details={"version_id": version_id})
    if item.status != PolicyStatus.DRAFT.value:
        raise Validation(
            "已发布/已失效的版本不可修改，请新建版本",
            details={"version_id": version_id, "status": item.status},
        )
    normalized_config = _normalize_policy_config(config)
    before = {"config": item.config}
    item.config = normalized_config
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.POLICY_CHANGE,
        entity_type="policy_version",
        entity_id=item.id,
        actor=actor,
        before=before,
        after={"config": normalized_config},
    )
    return _ver_out(item)


# ── 状态收口：SUPERSEDED（草稿替代作废）与 EXPIRED（过期清扫） ──────

def supersede_draft_version(
    session: Session,
    version_id: int,
    *,
    actor: str,
    reason: str,
    replaced_by_version_id: int | None = None,
) -> dict[str, Any]:
    """作废草稿版本（SUPERSEDED）。

    语义边界：**只有 DRAFT 可作废**。已发布（ACTIVE）版本是历史日期的
    解析口径（resolve_version 按 status=ACTIVE + 生效期取版本），
    作废会挖掉历史规则的落点；要下线生效版本请新建版本封口生效期。
    replaced_by_version_id 用于记录替代关系（可选，须属同一规则定义）。
    """
    item = session.get(PolicyVersion, version_id)
    if item is None:
        raise NotFound(f"规则版本 {version_id} 不存在", details={"version_id": version_id})
    if item.status != PolicyStatus.DRAFT.value:
        raise Validation(
            "只能作废草稿版本；已发布版本是历史解析口径，请用新建版本封口生效期",
            details={"version_id": version_id, "status": item.status},
        )
    text = _required_text(reason, field="reason", message="作废必须填写理由")
    if replaced_by_version_id is not None:
        if replaced_by_version_id == version_id:
            raise Validation("替代版本不能是被作废版本本身", details={"version_id": version_id})
        replacement = session.get(PolicyVersion, replaced_by_version_id)
        if replacement is None or (
            replacement.policy_definition_id != item.policy_definition_id
        ):
            raise Validation(
                "替代版本不存在或不属于同一规则定义",
                details={"replaced_by_version_id": replaced_by_version_id},
            )
    before = {"status": item.status}
    item.status = PolicyStatus.SUPERSEDED.value
    item.updated_by = actor
    session.flush()
    record_audit(
        session,
        action=AuditAction.POLICY_CHANGE,
        entity_type="policy_version",
        entity_id=item.id,
        actor=actor,
        before=before,
        after={
            "status": item.status,
            "replaced_by_version_id": replaced_by_version_id,
            "reason": text,
        },
        reason=text,
    )
    return _ver_out(item)


def expire_lapsed_versions(
    session: Session, *, on: date, actor: str = "system"
) -> dict[str, Any]:
    """把生效期已结束（effective_to < on）的 ACTIVE 版本固化为 EXPIRED。

    resolve_version 本就按日期过滤，不会命中过期版本；本函数只做
    状态落地，保证列表/报表按状态过滤时口径与日期口径一致。
    """
    rows = session.scalars(
        select(PolicyVersion).where(PolicyVersion.status == PolicyStatus.ACTIVE.value)
    ).all()
    swept: list[int] = []
    for item in rows:
        if item.effective_to is not None and item.effective_to < on:
            before = {"status": item.status}
            item.status = PolicyStatus.EXPIRED.value
            item.updated_by = actor
            swept.append(item.id)
            record_audit(
                session,
                action=AuditAction.POLICY_CHANGE,
                entity_type="policy_version",
                entity_id=item.id,
                actor=actor,
                before=before,
                after={"status": item.status, "effective_to": item.effective_to.isoformat()},
            )
    session.flush()
    return {"swept": len(swept), "version_ids": swept, "on": on.isoformat()}


# ── T20 / BAS-06-04：生效期解析 + 快照固化 ───────────────────────

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
        "captured_at": datetime.now().isoformat(),
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


# ── T20 / BAS-06-03：订单多人利润分配 ────────────────────────────
