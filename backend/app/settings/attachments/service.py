"""订单详情附件服务：统一文件索引、权限、软删除与审计。"""
from __future__ import annotations

import base64
import binascii
import hashlib
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.shared.audit import record_audit
from app.core.errors import Conflict, ErrorCode, NotFound, PermissionDenied, Validation
from app.core.time import now_second
from app.core.security import (
    PERM_DEPOSIT_POST,
    PERM_FINANCE_ORDER_EVENT_POST,
    PERM_FINANCE_READ,
    PERM_ORDER_CREATE,
    PERM_ORDER_EVENT_POST,
    PERM_ORDER_UPDATE,
    PERM_REPORT_READ,
    PERM_TRANSFER_POST,
    CurrentUser,
)
from app.settings.auth.session import (
    owner_scope_filter,
)
from app.core.settings import get_settings
from app.shared.numbering import allocate_number
from app.domain.attachments import Attachment
from app.domain.enums import AuditAction, SequenceKey
from app.domain.trade import Cashflow, Installment, Order, OrderEvent
from app.settings.attachments.storage import track_file


MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
ENTITY_TYPES = frozenset({"order", "order_event", "cashflow", "installment"})
_SAFE_FILENAME = re.compile(r"^[^/\\]+$")


@dataclass(frozen=True)
class _Target:
    entity_type: str
    entity_id: str
    order: Order | None = None
    pool_id: int | None = None


def _validate_entity_type(entity_type: str) -> str:
    value = entity_type.strip().lower()
    if value not in ENTITY_TYPES:
        raise Validation(
            "附件关联对象类型无效",
            details={"field": "entity_type", "value": entity_type, "allowed": sorted(ENTITY_TYPES)},
        )
    return value


def _load_target(session: Session, entity_type: str, entity_id: str) -> _Target:
    entity_type = _validate_entity_type(entity_type)
    identifier = entity_id.strip()
    if not identifier:
        raise Validation("附件关联对象编号不能为空", details={"field": "entity_id"})

    if entity_type == "order":
        order = session.scalar(select(Order).where(Order.order_no == identifier))
        if order is None:
            raise NotFound("附件关联的订单不存在", details={"order_no": identifier})
        return _Target(entity_type, identifier, order=order)

    if entity_type == "order_event":
        event = session.scalar(select(OrderEvent).where(OrderEvent.event_no == identifier))
        if event is None:
            raise NotFound("附件关联的订单事件不存在", details={"event_no": identifier})
        order = session.get(Order, event.order_id)
        return _Target(entity_type, identifier, order=order, pool_id=event.pool_id)

    if entity_type == "cashflow":
        flow = session.scalar(select(Cashflow).where(Cashflow.flow_no == identifier))
        if flow is None:
            raise NotFound("附件关联的资金流水不存在", details={"flow_no": identifier})
        order = session.get(Order, flow.order_id) if flow.order_id is not None else None
        return _Target(entity_type, identifier, order=order, pool_id=flow.pool_id)

    if entity_type == "installment":
        installment = session.scalar(
            select(Installment).where(Installment.inst_no == identifier)
        )
        if installment is None:
            raise NotFound("附件关联的分期合约不存在", details={"inst_no": identifier})
        return _Target(entity_type, identifier, order=session.get(Order, installment.order_id))

    raise Validation("附件关联对象类型无效", details={"field": "entity_type", "value": entity_type})


def _assert_permission(user: CurrentUser, target: _Target, *, write: bool) -> None:
    if user.is_admin:
        return
    if target.entity_type == "cashflow":
        # 资金流水附件「写」不得只凭读权限放行：须持任一资金写权限，
        # 否则 finance.read 的只读角色也能给流水挂/改附件（越权）。
        if write:
            allowed = user.has_any((
                PERM_DEPOSIT_POST, PERM_TRANSFER_POST, PERM_FINANCE_ORDER_EVENT_POST,
            ))
        else:
            allowed = user.has(PERM_FINANCE_READ)
    elif write:
        allowed = user.has_any((PERM_ORDER_UPDATE, PERM_ORDER_EVENT_POST))
    else:
        allowed = user.has_any((PERM_ORDER_CREATE, PERM_ORDER_EVENT_POST, PERM_FINANCE_READ, PERM_REPORT_READ))
    if not allowed:
        raise PermissionDenied("当前角色无权访问该附件", details={"entity_type": target.entity_type})


def _assert_visible(session: Session, user: CurrentUser, target: _Target) -> None:
    if user.is_admin:
        return
    if target.order is not None:
        scope = owner_scope_filter(Order.owner_id, user, session)
        if scope is not None and session.scalar(
            select(Order.id).where(Order.id == target.order.id, scope)
        ) is None:
            raise NotFound("附件不存在")
    if (target.entity_type == "cashflow" or target.order is None) and target.pool_id is not None and not user.can_see_pool(target.pool_id):
        raise NotFound("附件不存在")
    if target.entity_type == "cashflow" and target.pool_id is None:
        raise NotFound("附件不存在")


def _storage_root() -> Path:
    root = get_settings().attachment_storage_path
    root.mkdir(parents=True, exist_ok=True)
    return root


def _decode_content(raw: str) -> bytes:
    value = raw.strip()
    if "," in value and value.lower().startswith("data:"):
        value = value.split(",", 1)[1]
    try:
        content = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise Validation("附件内容必须是有效的 Base64", details={"field": "content_base64"}) from exc
    if not content:
        raise Validation("附件内容不能为空", details={"field": "content_base64"})
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise Validation(
            "附件大小不能超过 20MB",
            details={"field": "content_base64", "max_bytes": MAX_ATTACHMENT_BYTES},
        )
    return content


def _validate_file(file_name: str, content_type: str) -> tuple[str, str]:
    name = file_name.strip()
    content = content_type.strip().lower()
    if not _SAFE_FILENAME.fullmatch(name):
        raise Validation("附件文件名不能包含路径", details={"field": "file_name"})
    if not content:
        raise Validation("附件类型不能为空", details={"field": "content_type"})
    return name, content


def list_attachments(
    session: Session,
    *,
    entity_type: str,
    entity_id: str,
    user: CurrentUser,
) -> list[Attachment]:
    target = _load_target(session, entity_type, entity_id)
    _assert_permission(user, target, write=False)
    _assert_visible(session, user, target)
    return list(
        session.scalars(
            select(Attachment)
            .where(
                Attachment.entity_type == target.entity_type,
                Attachment.entity_id == target.entity_id,
                Attachment.deleted_at.is_(None),
            )
            .order_by(Attachment.created_at, Attachment.id)
        ).all()
    )


def _has_visible_duplicate(session: Session, digest: str, user: CurrentUser) -> bool:
    """Only disclose a duplicate when its existing attachment is readable by this user."""
    for existing in session.scalars(select(Attachment).where(
        Attachment.sha256 == digest, Attachment.deleted_at.is_(None),
    )):
        try:
            target = _load_target(session, existing.entity_type, existing.entity_id)
            _assert_permission(user, target, write=False)
            _assert_visible(session, user, target)
        except (NotFound, PermissionDenied, Validation):
            continue
        return True
    return False


def create_attachment(
    session: Session,
    *,
    entity_type: str,
    entity_id: str,
    file_name: str,
    content_type: str,
    content_base64: str,
    user: CurrentUser,
    allow_duplicate: bool = False,
) -> Attachment:
    target = _load_target(session, entity_type, entity_id)
    _assert_permission(user, target, write=True)
    _assert_visible(session, user, target)
    name, content = _validate_file(file_name, content_type)
    payload = _decode_content(content_base64)
    digest = hashlib.sha256(payload).hexdigest()
    # Serialize identical uploads so two simultaneous requests cannot both skip the warning.
    lock_key = int.from_bytes(bytes.fromhex(digest[:16]), "big", signed=True)
    session.execute(select(func.pg_advisory_xact_lock(lock_key)))
    if not allow_duplicate and _has_visible_duplicate(session, digest, user):
        raise Conflict("已存在相同内容的附件，是否继续上传？", code=ErrorCode.DUPLICATE_ATTACHMENT)
    attachment_no = allocate_number(session, SequenceKey.ATTACHMENT)
    with tempfile.NamedTemporaryFile(prefix=f"{attachment_no}-", dir=_storage_root(), delete=False) as output:
        path = Path(output.name)
        try:
            output.write(payload)
        except Exception:
            path.unlink(missing_ok=True)
            raise
    storage_key = path.name
    try:
        track_file(session, path)
    except Exception:
        path.unlink(missing_ok=True)
        raise
    item = Attachment(
        attachment_no=attachment_no,
        entity_type=target.entity_type,
        entity_id=target.entity_id,
        file_name=name,
        storage_key=storage_key,
        content_type=content,
        size_bytes=len(payload),
        sha256=digest,
        created_by=user.username,
        updated_by=user.username,
    )
    try:
        session.add(item)
        session.flush()
        record_audit(
            session,
            action=AuditAction.ATTACHMENT_UPLOAD,
            entity_type="attachment",
            entity_id=item.attachment_no,
            actor=user.username,
            after={
                "attachment_no": item.attachment_no,
                "entity_type": item.entity_type,
                "entity_id": item.entity_id,
                "file_name": item.file_name,
                "size_bytes": item.size_bytes,
                "sha256": item.sha256,
            },
        )
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return item


def get_attachment(session: Session, attachment_id: int, user: CurrentUser) -> Attachment:
    item = session.get(Attachment, attachment_id)
    if item is None or item.deleted_at is not None:
        raise NotFound("附件不存在", details={"attachment_id": attachment_id})
    target = _load_target(session, item.entity_type, item.entity_id)
    _assert_permission(user, target, write=False)
    _assert_visible(session, user, target)
    return item


def attachment_path(item: Attachment) -> Path:
    root = _storage_root().resolve()
    path = (root / item.storage_key).resolve()
    if root not in path.parents:
        raise Validation("附件存储路径无效")
    if not path.is_file():
        raise NotFound("附件文件不存在", details={"attachment_no": item.attachment_no})
    return path


def delete_attachment(
    session: Session, attachment_id: int, *, user: CurrentUser
) -> Attachment:
    item = get_attachment(session, attachment_id, user)
    target = _load_target(session, item.entity_type, item.entity_id)
    _assert_permission(user, target, write=True)
    item.deleted_at = now_second()
    item.updated_by = user.username
    session.flush()
    record_audit(
        session,
        action=AuditAction.ATTACHMENT_DELETE,
        entity_type="attachment",
        entity_id=item.attachment_no,
        actor=user.username,
        after={"deleted_at": item.deleted_at.isoformat()},
        reason="附件软删除，保留审计与文件追溯",
    )
    return item


__all__ = [
    "ENTITY_TYPES",
    "MAX_ATTACHMENT_BYTES",
    "attachment_path",
    "create_attachment",
    "delete_attachment",
    "get_attachment",
    "list_attachments",
]
