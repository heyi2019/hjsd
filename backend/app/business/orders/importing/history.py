"""订单导入批次留痕与安全撤回。审计只追加，业务改动在同一事务内撤回。"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.errors import NotFound, PermissionDenied, Validation
from app.core.security import CurrentUser, PERM_FINANCE_ORDER_EVENT_POST, PERM_ORDER_EVENT_POST
from app.domain.attachments import Attachment
from app.domain.base import Base
from app.domain.enums import AuditAction
from app.domain.foundation import AuditLog, Pool
from app.domain.notifications import Notification
from app.domain.parties import OrderCounterpartyRole, OrderCustomerRole
from app.domain.trade import Account, BalanceSnapshot, Cashflow, Order, OrderEvent, OrderProfitAllocation, RebateRecord
from app.shared.audit import record_audit
from app.shared.order_access import get_order

_ENTITY = "order_import_batch"
_CREATE = AuditAction.ORDER_IMPORT.value
_REVERT = AuditAction.ORDER_IMPORT_REVERT.value
_MODELS = (Order, Account, OrderEvent, Cashflow, RebateRecord, OrderProfitAllocation,
           OrderCustomerRole, OrderCounterpartyRole)
_TABLES = {model.__tablename__: model.__table__ for model in _MODELS}


def _json_value(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"无法保存导入记录字段类型：{type(value).__name__}")


def _clean(row) -> dict:
    return json.loads(json.dumps(dict(row), ensure_ascii=False, default=_json_value))


def _snapshot(session: Session, numbers: list[str]) -> dict[str, dict[str, dict[str, dict]]]:
    """按订单批量读取受导入影响的实体，避免为每个订单逐条查询。"""
    if not numbers:
        return {}
    orders = session.execute(select(Order.__table__).where(Order.order_no.in_(numbers))).mappings().all()
    result = {row["order_no"]: {name: {} for name in _TABLES} for row in orders}
    by_order = {row["id"]: row["order_no"] for row in orders}
    account_orders = {row["account_id"]: row["order_no"] for row in orders if row["account_id"] is not None}
    for row in orders:
        result[row["order_no"]]["orders"][str(row["id"])] = _clean(row)
    if account_orders:
        for row in session.execute(select(Account.__table__).where(Account.id.in_(account_orders))).mappings():
            result[account_orders[row["id"]]]["stocks"][str(row["id"])] = _clean(row)
    if by_order:
        for model in _MODELS[2:]:
            foreign_key = model.source_order_id if model is RebateRecord else model.order_id
            for row in session.execute(select(model.__table__).where(foreign_key.in_(by_order))).mappings():
                order_id = row["source_order_id"] if model is RebateRecord else row["order_id"]
                result[by_order[order_id]][model.__tablename__][str(row["id"])] = _clean(row)
    return result


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def capture_before(session: Session, numbers: list[str]) -> dict:
    if numbers:
        session.scalars(select(Order).where(Order.order_no.in_(numbers)).order_by(Order.id).with_for_update()).all()
    return _snapshot(session, numbers)


def record_import(session: Session, *, before: dict, result: dict, file_name: str, user: CurrentUser) -> int:
    numbers = [row["order_no"] for row in result["rows"] if row["action"] in {"create", "update", "inventory"}]
    session.flush()
    after = _snapshot(session, numbers)
    created: dict[str, list[int]] = {name: [] for name in _TABLES}
    changed: dict[str, dict[str, dict]] = {name: {} for name in _TABLES}
    reversible = True
    reason = None
    for number in numbers:
        old, new = before.get(number, {}), after.get(number, {})
        for name in _TABLES:
            old_rows, new_rows = old.get(name, {}), new.get(name, {})
            if old_rows.keys() - new_rows.keys():
                reversible, reason = False, "本次导入包含无法自动恢复的历史记录"
            created[name].extend(int(key) for key in new_rows.keys() - old_rows.keys())
            for key in new_rows.keys() & old_rows.keys():
                previous = {column: value for column, value in old_rows[key].items()
                            if value != new_rows[key].get(column)}
                if previous:
                    if "updated_at" in old_rows[key]:
                        previous["updated_at"] = old_rows[key]["updated_at"]
                    changed[name][key] = previous
    if created["rebate_records"] or changed["rebate_records"]:
        reversible, reason = False, "返点登记不能删除或撤回，请按资金规则处理"
    if not any(created.values()) and not any(changed.values()):
        reversible, reason = False, "本次导入没有产生可撤回的数据"
    metadata = {
        "file_name": Path(file_name).name,
        "created": result["created"], "updated": result["updated"], "skipped": result["skipped"],
        "inventories_created": result["inventories_created"],
        "numbers": numbers, "hashes": {number: _digest(after[number]) for number in numbers},
        "created_rows": created, "changed_rows": changed, "reversible": reversible, "reason": reason,
    }
    entry = record_audit(session, action=_CREATE, entity_type=_ENTITY, actor=user.username, after=metadata)
    return entry.id


def _view(entry: AuditLog, reverted: bool) -> dict:
    value = entry.after_json or {}
    return {
        "id": entry.id, "file_name": value.get("file_name", ""), "actor": entry.actor,
        "imported_at": entry.occurred_at, "created": value.get("created", 0),
        "updated": value.get("updated", 0), "skipped": value.get("skipped", 0),
        "inventories_created": value.get("inventories_created", 0),
        "status": "reverted" if reverted else "imported",
        "reversible": bool(value.get("reversible")) and not reverted,
        "reason": value.get("reason"),
    }


def list_imports(session: Session, user: CurrentUser) -> list[dict]:
    stmt = select(AuditLog).where(AuditLog.entity_type == _ENTITY, AuditLog.action == _CREATE)
    if not user.is_admin:
        stmt = stmt.where(AuditLog.actor == user.username)
    entries = session.scalars(stmt.order_by(AuditLog.id.desc())).all()
    reverted = set(session.scalars(select(AuditLog.entity_id).where(
        AuditLog.entity_type == _ENTITY, AuditLog.action == _REVERT,
        AuditLog.entity_id.in_([str(entry.id) for entry in entries]),
    )).all()) if entries else set()
    return [_view(entry, str(entry.id) in reverted) for entry in entries]


def _restore_value(column, value):
    if value is None:
        return None
    kind = column.type.python_type
    if kind is datetime:
        return datetime.fromisoformat(value)
    if kind is date:
        return date.fromisoformat(value)
    if kind is Decimal:
        return Decimal(value)
    return value


def _check_external_references(session: Session, created: dict[str, list[int]]) -> None:
    """数据库外键即使配置为 SET NULL 或 CASCADE，也不能悄悄改动批次外数据。"""
    for table in Base.metadata.tables.values():
        for foreign_key in table.foreign_keys:
            target = foreign_key.column.table.name
            ids = created.get(target, [])
            if not ids or foreign_key.column.name != "id":
                continue
            query = select(1).select_from(table).where(foreign_key.parent.in_(ids))
            own_ids = created.get(table.name, [])
            if own_ids:
                query = query.where(table.c.id.not_in(own_ids))
            if session.execute(query.limit(1)).first():
                raise Validation("导入后已有其他业务关联，不能直接撤回")


def revert_import(session: Session, batch_id: int, user: CurrentUser) -> dict:
    with session.begin_nested():
        entry = session.scalar(select(AuditLog).where(
            AuditLog.id == batch_id, AuditLog.entity_type == _ENTITY, AuditLog.action == _CREATE,
        ).with_for_update())
        if entry is None:
            raise NotFound("导入记录不存在")
        if not user.is_admin and entry.actor != user.username:
            raise PermissionDenied("只能撤回本人导入的记录")
        if session.scalar(select(AuditLog.id).where(
            AuditLog.entity_type == _ENTITY, AuditLog.action == _REVERT, AuditLog.entity_id == str(batch_id),
        )):
            raise Validation("该批次已经撤回")
        data = entry.after_json or {}
        if not data.get("reversible"):
            raise Validation(data.get("reason") or "该批次不能自动撤回")
        numbers = data["numbers"]
        orders = session.scalars(select(Order).where(Order.order_no.in_(numbers)).order_by(Order.id).with_for_update()).all()
        for order in orders:
            get_order(session, order.id, user)
        created, changed = data["created_rows"], data["changed_rows"]
        cash_ids = created["cashflow"] + [int(key) for key in changed["cashflow"]]
        earliest_flow: dict[int, date] = {}
        if cash_ids:
            if not (user.has(PERM_ORDER_EVENT_POST) or user.has(PERM_FINANCE_ORDER_EVENT_POST)):
                raise PermissionDenied("当前角色无权撤回订单资金流水")
            flows = session.scalars(select(Cashflow).where(Cashflow.id.in_(cash_ids))).all()
            for flow in flows:
                if not user.can_see_pool(flow.pool_id):
                    raise PermissionDenied("无权操作导入涉及的资金账户")
                earliest_flow[flow.pool_id] = min(earliest_flow.get(flow.pool_id, flow.occurred_on), flow.occurred_on)
            if earliest_flow:
                # 与对账采用相同的账户锁；等待后再检查快照，避免并发固化旧余额。
                session.scalars(select(Pool.id).where(Pool.id.in_(earliest_flow)).order_by(Pool.id)
                                .with_for_update(key_share=True)).all()
        current = _snapshot(session, numbers)
        if any(number not in current or _digest(current[number]) != expected for number, expected in data["hashes"].items()):
            raise Validation("导入后订单或关联记录已发生变化，不能直接撤回")
        if earliest_flow:
            latest_snapshots = session.execute(
                select(BalanceSnapshot.pool_id, func.max(BalanceSnapshot.snapshot_on))
                .where(BalanceSnapshot.pool_id.in_(earliest_flow))
                .group_by(BalanceSnapshot.pool_id)
            ).all()
            if any(day >= earliest_flow[pool_id] for pool_id, day in latest_snapshots):
                raise Validation("导入涉及已对账的资金流水，不能直接撤回")
        created_ids = {name: set(ids) for name, ids in created.items()}
        references: dict[str, list[str]] = {"order": [], "order_event": [], "cashflow": []}
        for item in current.values():
            for table, entity, field in (("orders", "order", "order_no"), ("order_events", "order_event", "event_no"),
                                         ("cashflow", "cashflow", "flow_no")):
                references[entity].extend(row[field] for row in item[table].values() if row["id"] in created_ids[table])
        if references["order"] and session.scalar(select(Notification.id).where(
            Notification.entity_type == "order", Notification.entity_id.in_(references["order"]),
        ).limit(1)):
            raise Validation("导入后已有订单通知，不能直接撤回")
        for entity, identifiers in references.items():
            if not identifiers:
                continue
            if session.scalar(select(Attachment.id).where(
                Attachment.entity_type == entity, Attachment.entity_id.in_(identifiers),
                Attachment.deleted_at.is_(None),
            ).limit(1)):
                raise Validation("导入后已上传关联附件，不能直接撤回")
        for name, rows in changed.items():
            table = _TABLES[name]
            for row_id, values in rows.items():
                session.execute(update(table).where(table.c.id == int(row_id)).values(
                    **{key: _restore_value(table.c[key], value) for key, value in values.items()}
                ))
        _check_external_references(session, created)
        for table in reversed(Base.metadata.sorted_tables):
            ids = created.get(table.name, [])
            if ids:
                session.execute(delete(table).where(table.c.id.in_(ids)))
        record_audit(session, action=_REVERT, entity_type=_ENTITY, entity_id=entry.id, actor=user.username,
                     after={"file_name": data.get("file_name", ""), "orders": numbers})
        session.flush()
        return _view(entry, True)
