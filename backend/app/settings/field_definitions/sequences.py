"""业务编号序列服务。"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.shared.numbering import allocate_number
from app.domain.foundation import DocumentSequence, OrderTypeDef

RETIRED_SEQUENCE_KEYS = frozenset({"ATTACHMENT", "QUALITY_ISSUE", "IMPORT", "INSTALLMENT"})

# ----------------------------------------------------------------------- 编号
def next_order_no(session: Session, order_type: OrderTypeDef) -> str:
    """按业务独立递增分配 `HS0001` / `TH0001` 之类编号。"""
    return allocate_number(session, order_type.sequence_key)
def list_sequences(session: Session) -> list[DocumentSequence]:
    return list(session.scalars(
        select(DocumentSequence)
        .where(DocumentSequence.sequence_key.not_in(RETIRED_SEQUENCE_KEYS))
        .order_by(DocumentSequence.sequence_key)
    ))
