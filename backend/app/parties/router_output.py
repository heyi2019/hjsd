"""parties.router 输出装配 helper（需求池 / 合作方）。"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.core.audit import record_audit
from app.core.security import PERM_CUSTOMER_CONTACT_READ, CurrentUser
from app.domain.enums import AuditAction
from app.parties import schemas
from app.parties._common import to_counterparty_out
from app.parties.fields import get_extra_values

def _actor(user: CurrentUser) -> str:
    return user.username


def _lead_output(db: Session, item) -> schemas.LeadOut:
    output = schemas.LeadOut.model_validate(item)
    output.extra_values = get_extra_values(
        db, entity_type="lead", entity_id=item.id
    )
    return output


def _counterparty_output(
    db: Session, item, *, user: CurrentUser, reveal: bool | None = None,
    audit_reveal: bool = False,
) -> schemas.CounterpartyOut:
    # 合作方联系方式默认脱敏；显式 reveal 且持联系方式读权限才回显全值。
    # 仅 GET 显式读取（audit_reveal=True）记 CONTACT_READ；新增/编辑回显是写操作
    # 自身性质，已有各自业务审计，不再重复记一条「读取」。
    show_full = bool(reveal) and user.has(PERM_CUSTOMER_CONTACT_READ)
    if show_full and audit_reveal:
        record_audit(
            db,
            action=AuditAction.CONTACT_READ,
            entity_type="counterparty",
            entity_id=item.counterparty_no,
            actor=_actor(user),
        )
    data = to_counterparty_out(
        item,
        reveal_contact=show_full,
        extra_values=get_extra_values(
            db, entity_type="counterparty", entity_id=item.id
        ),
    )
    return schemas.CounterpartyOut.model_validate(data)
