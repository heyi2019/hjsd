"""policy：经营规则定义 / 版本 / 审批 / 生效期解析（T19 / T20，BAS-06-01~04）。

红线（BAS-06-02 / BAS-06-04）：
1. **已被引用的版本不可修改/删除** —— 只能新建版本；
2. **同范围的新版本不得与已有版本有效期重叠**；
3. **已发生的业务不因规则改版而变化** —— 靠 `resolve_version` 返回
   「当时生效的版本」+ 业务对象上的 `policy_snapshot` 固化实现；
4. 发布只影响 `effective_from` 之后**新建**的业务，不重算历史。

有效期模型：`[effective_from, effective_to)` 左闭右开，NULL 表示至今。
这样相邻版本（前者 to = 次者 from）不重叠且无空隙。
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.errors import NotFound, Validation
from app.core.money import to_money
from app.domain.enums import (
    AuditAction,
    AllocationRole,
    PolicyScopeType,
    PolicyStatus,
)
from app.domain.parties import PolicyDefinition, PolicyVersion
from app.domain.foundation import OrderTypeDef, Pool
from app.domain.users import User
from app.domain.trade import Installment, Order, OrderEvent, OrderProfitAllocation
from app.core.security import CurrentUser
from app.policy.schemas import ProfitAllocationItem


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
    from app.orders import service as orders_service

    return orders_service.get_order(session, order_id, user)


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

def _normalize_allocation_item(value: Any) -> dict[str, Any]:
    try:
        return ProfitAllocationItem.model_validate(value).model_dump()
    except PydanticValidationError as exc:
        errors = exc.errors()
        has_rate_error = any(
            error.get("loc") and error["loc"][-1] in {"allocation_rate", "allocation_amount"}
            for error in errors
        )
        raise Validation(
            "分配比例/金额必须是数值" if has_rate_error else "利润分配字段校验失败",
            details={"field": "items", "errors": errors},
        ) from exc


def set_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str = "system",
    form_extra: Mapping[str, Any] | None = None,
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    """整单重设分润。

    两种录入口径，整单只能选其一：

    - **按动作**（items 都带 allocation_type）：沿用 BAS-06-03 的四项结构
      （买号/售出/运营/公司归属），比例合计必须 100%，收益人绑定动作执行人。
    - **按人**（items 都不带 allocation_type）：每行一个姓名（user_id；为空表示
      公司归属），比例与金额都选填——填比例按利润占比分、填金额按固定额分。
      纯比例时合计仍须 100%；一旦出现金额，改为校验金额合计不超过订单利润，
      因为此时「剩余未分配」默认留在公司，强行凑 100% 会逼用户编数字。
    """
    normalized_items = [_normalize_allocation_item(item) for item in items]
    typed = [item for item in normalized_items if item.get("allocation_type")]
    if typed and len(typed) != len(normalized_items):
        raise Validation("按动作分润与按人分润不能混用，请统一为其中一种")
    if typed:
        result = _set_action_allocations(
            session, order_id, items=items, actor=actor, user=user
        )
    else:
        result = _set_person_allocations(
            session, order_id, items=normalized_items, actor=actor, user=user
        )
    if form_extra:
        # ALLOCATION 作用域自定义字段值合并进订单 form_extra。
        order = _scoped_order(session, order_id, user)
        order.form_extra = {**(order.form_extra or {}), **dict(form_extra)}
        session.flush()
    return result


def _set_person_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str,
    user: CurrentUser | None,
) -> list[dict[str, Any]]:
    """按人分润：姓名 + 比例或金额（二者都选填，同一行不可同时填）。"""
    from app.orders.amounts import order_amounts

    order = _scoped_order(session, order_id, user)
    if not items:
        raise Validation("分润不能为空", details={"field": "items"})

    total_rate = Decimal("0")
    total_amount = Decimal("0")
    user_ids: set[int] = set()
    person_roles: set[tuple[int, str]] = set()
    company_rows = 0
    for item in items:
        rate = to_money(item.get("allocation_rate") or 0)
        amount = to_money(item.get("allocation_amount") or 0)
        role = str(item.get("role") or "OWNER").upper()
        if role not in AllocationRole.values():
            raise Validation(
                f"分配角色必须为 {AllocationRole.values()}",
                details={"field": "role", "value": item.get("role")},
            )
        if rate > 0 and amount > 0:
            raise Validation(
                "同一分润行不能同时填比例和金额，二者只能选一个",
                details={"field": "items"},
            )
        user_id = item.get("user_id")
        if user_id is None:
            company_rows += 1
            if company_rows > 1:
                raise Validation("公司归属只能有一行", details={"field": "items"})
        else:
            # 去重键与 DB 唯一约束 uq_order_profit_alloc(order_id, allocation_type, user_id, role) 对齐：
            # 同一人可担任多个角色（如既做销售又做服务），但不能在同一角色下拿两份。
            if (int(user_id), role) in person_roles:
                raise Validation(
                    "同一人员在同一角色下不可重复分润",
                    details={"field": "items.user_id", "role": role},
                )
            person_roles.add((int(user_id), role))
            user_ids.add(int(user_id))
        total_rate += rate
        total_amount += amount

    existing_user_ids = {
        user_id
        for user_id in session.scalars(select(User.id).where(User.id.in_(user_ids))).all()
    }
    missing_user_ids = sorted(user_ids - existing_user_ids)
    if missing_user_ids:
        raise Validation(
            "分润人员不存在",
            details={"field": "items.user_id", "missing": missing_user_ids},
        )

    if total_amount > 0:
        profit = order_amounts(session, order_id)["PROFIT"]
        if profit <= 0:
            raise Validation(
                "该单尚无正利润，不能按金额分润；请改用比例分润",
                details={"profit": str(profit)},
            )
        if total_amount > profit:
            raise Validation(
                f"分润金额合计 {total_amount} 超过订单利润 {profit}",
                details={"total_amount": str(total_amount), "profit": str(profit)},
            )
        if total_rate > Decimal("100"):
            raise Validation(
                "存在按金额分润时，比例合计不能超过 100%",
                details={"total_rate": str(total_rate)},
            )
    elif total_rate != Decimal("100.00"):
        raise Validation(
            "有效分配比例合计必须为 100%",
            details={"total": str(total_rate), "items": len(items)},
        )

    for old in session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order_id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in items:
        row = OrderProfitAllocation(
            order_id=order_id,
            user_id=int(item["user_id"]) if item.get("user_id") is not None else None,
            role=str(item.get("role") or "OWNER").upper(),
            allocation_type=None,
            allocation_rate=to_money(item.get("allocation_rate") or 0),
            allocation_amount=to_money(item.get("allocation_amount") or 0),
            policy_version_id=order.policy_version_id,
        )
        session.add(row)
        created.append(row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.PROFIT_ALLOCATION_SET,
        entity_type="order",
        entity_id=order_id,
        actor=actor,
        after={
            "allocations": [
                {
                    "user_id": r.user_id,
                    "role": r.role,
                    "allocation_type": r.allocation_type,
                    "rate": str(r.allocation_rate),
                    "amount": str(r.allocation_amount),
                }
                for r in created
            ]
        },
    )
    return list_allocations(session, order_id, user=user)


def _set_action_allocations(
    session: Session,
    order_id: int,
    *,
    items: list[dict[str, Any]],
    actor: str = "system",
    user: CurrentUser | None = None,
) -> list[dict[str, Any]]:
    """整单重设利润分配。**有效比例合计必须为 100%**（BAS-06-03）。"""
    order = _scoped_order(session, order_id, user)
    if not items:
        raise Validation("利润分配不能为空", details={"field": "items"})

    normalized_items = [_normalize_allocation_item(item) for item in items]
    total = Decimal("0")
    user_ids: set[int] = set()
    allocation_types: set[str] = set()
    if len(normalized_items) != 4 or any(not item.get("allocation_type") for item in normalized_items):
        raise Validation("利润分配必须且只能包含买号、售出、运营和公司归属四项")
    has_typed_items = True
    action_actor_ids: dict[str, int] = {}
    if has_typed_items:
        for action_type in ("BUY", "SELL"):
            action = session.scalar(
                select(OrderEvent)
                .where(
                    OrderEvent.order_id == order.id,
                    OrderEvent.event_type == action_type,
                    OrderEvent.is_posted.is_(True),
                )
                .order_by(OrderEvent.id.desc())
            )
            if action is None and action_type == "BUY" and order.account_id is not None:
                action = session.scalar(select(OrderEvent).join(Order, Order.id == OrderEvent.order_id).where(Order.account_id == order.account_id, OrderEvent.event_type == "BUY", OrderEvent.is_posted.is_(True)).order_by(OrderEvent.id.desc()))
            if action is not None:
                actor_id = session.scalar(select(User.id).where(User.username == action.created_by))
                if actor_id is None:
                    raise Validation(
                        f"{action_type} 动作执行人不存在，无法绑定收益人",
                        details={"event_id": action.id, "actor": action.created_by},
                    )
                action_actor_ids[action_type] = actor_id
            elif action_type == "SELL":
                contract = session.scalar(select(Installment).where(Installment.order_id == order.id, Installment.contract_type == "STOCK_SALE"))
                if contract is not None:
                    actor_id = session.scalar(select(User.id).where(User.username == contract.created_by))
                    if actor_id is None:
                        raise Validation("售出动作执行人不存在，无法绑定收益人")
                    action_actor_ids[action_type] = actor_id
            elif action_type == "BUY" and order.order_type in {"HS", "TH", "DG"}:
                # 回收、提号、代挂都属于买号业务动作；DG 沿用标准 SELL
                # 资金事件，因此其买号收益人取建单操作人员。
                creator_id = session.scalar(select(User.id).where(User.username == order.created_by))
                if creator_id is not None:
                    action_actor_ids[action_type] = creator_id
    for item in normalized_items:
        rate = to_money(item.get("allocation_rate"))
        role = str(item.get("role") or "").upper()
        if role not in AllocationRole.values():
            raise Validation(
                f"分配角色必须为 {AllocationRole.values()}",
                details={"field": "role", "value": item.get("role")},
            )
        allocation_type = item.get("allocation_type")
        if allocation_type is not None:
            allocation_type = str(allocation_type).upper()
            if allocation_type not in {"BUY", "SELL", "OPERATION", "COMPANY"}:
                raise Validation("分配项必须为 BUY、SELL、OPERATION 或 COMPANY；COMPANY 表示公司归属", details={"field": "allocation_type"})
            if allocation_type in allocation_types:
                raise Validation("利润分配项不可重复", details={"allocation_type": allocation_type})
            allocation_types.add(allocation_type)
            if allocation_type == "COMPANY" and item.get("user_id") is not None:
                raise Validation("公司收益不绑定人员", details={"field": "user_id"})
            if allocation_type == "OPERATION" and item.get("user_id") is None:
                raise Validation("人员收益必须绑定人员", details={"field": "user_id"})
            if allocation_type in {"BUY", "SELL"} and allocation_type not in action_actor_ids and item.get("user_id") is not None:
                raise Validation(f"{allocation_type} 收益人必须绑定对应动作执行人", details={"field": "user_id"})
            if allocation_type in {"BUY", "SELL"} and allocation_type in action_actor_ids:
                expected_user_id = action_actor_ids[allocation_type]
                if item.get("user_id") is not None and int(item["user_id"]) != expected_user_id:
                    raise Validation(
                        f"{allocation_type} 收益人必须绑定对应动作执行人",
                        details={"field": "user_id", "expected_user_id": expected_user_id},
                    )
                item["user_id"] = expected_user_id
        if item.get("user_id") is not None:
            user_ids.add(int(item["user_id"]))
        total += rate

    existing_user_ids = {
        user_id
        for user_id in session.scalars(select(User.id).where(User.id.in_(user_ids))).all()
    }
    missing_user_ids = sorted(user_ids - existing_user_ids)
    if missing_user_ids:
        raise Validation(
            "利润分配人员不存在",
            details={"field": "items.user_id", "missing": missing_user_ids},
        )

    if total != Decimal("100.00"):
        raise Validation(
            "有效分配比例合计必须为 100%",
            details={"total": str(total), "items": len(items)},
        )

    # 整单重设：先清后写，避免残留旧比例
    for old in session.scalars(
        select(OrderProfitAllocation).where(OrderProfitAllocation.order_id == order_id)
    ).all():
        session.delete(old)
    session.flush()

    created = []
    for item in normalized_items:
        allocation_type = str(item["allocation_type"]).upper() if item.get("allocation_type") else None
        row = OrderProfitAllocation(
            order_id=order_id,
            user_id=(
                action_actor_ids.get(allocation_type)
                if allocation_type in {"BUY", "SELL"} and allocation_type in action_actor_ids
                else (int(item["user_id"]) if item.get("user_id") is not None else None)
            ),
            role=str(item["role"]).upper(),
            allocation_type=allocation_type,
            allocation_rate=to_money(item.get("allocation_rate")),
            allocation_amount=to_money(item.get("allocation_amount") or 0),
            policy_version_id=order.policy_version_id,
        )
        session.add(row)
        created.append(row)
    session.flush()
    record_audit(
        session,
        action=AuditAction.PROFIT_ALLOCATION_SET,
        entity_type="order",
        entity_id=order_id,
        actor=actor,
        after={
            "allocations": [
                {"user_id": r.user_id, "role": r.role, "allocation_type": r.allocation_type, "rate": str(r.allocation_rate)}
                for r in created
            ]
        },
    )
    return list_allocations(session, order_id, user=user)


def list_allocations(
    session: Session, order_id: int, user: CurrentUser | None = None
) -> list[dict[str, Any]]:
    _scoped_order(session, order_id, user)
    rows = session.scalars(
        select(OrderProfitAllocation)
        .where(OrderProfitAllocation.order_id == order_id)
        .order_by(OrderProfitAllocation.id)
    ).all()
    total = Decimal("0")
    total_amount = Decimal("0")
    out = []
    for row in rows:
        total += to_money(row.allocation_rate)
        total_amount += to_money(row.allocation_amount)
        out.append(
            {
                "id": row.id,
                "order_id": row.order_id,
                "user_id": row.user_id,
                "role": row.role,
                "allocation_type": row.allocation_type,
                "allocation_rate": str(to_money(row.allocation_rate)),
                "allocation_amount": str(to_money(row.allocation_amount)),
                "policy_version_id": row.policy_version_id,
            }
        )
    return [
        {**item, "total_rate": str(total), "total_amount": str(total_amount)}
        for item in out
    ]


__all__ = [
    "create_definition",
    "create_version",
    "get_definition",
    "list_allocations",
    "list_definitions",
    "list_versions",
    "make_snapshot",
    "resolve_version",
    "set_allocations",
    "snapshot_for",
    "update_version_draft",
]
