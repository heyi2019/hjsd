"""业务编号序列服务。"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.core.numbering import allocate_number
from app.domain.foundation import DocumentSequence, OrderTypeDef
# ----------------------------------------------------------------------- 编号
def next_order_no(session: Session, order_type: OrderTypeDef) -> str:
    """按业务独立递增分配 `HS0001` / `TH0001` 之类编号。"""
    return allocate_number(session, order_type.sequence_key)
def list_sequences(session: Session) -> list[DocumentSequence]:
    return list(session.scalars(select(DocumentSequence).order_by(DocumentSequence.sequence_key)))
