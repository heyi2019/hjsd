"""编号规则端点（BAS-02/03，从原 router.py 逐字拆出）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import Validation
from app.core.security import CurrentUser
from app.shared.numbering import format_next_number, sequence_max
from app.field_definitions import schemas
from app.field_definitions.sequences import list_sequences as foundation_list_sequences
from ._router_shared import manage_order_types

router = APIRouter(tags=["BAS-02/03 业务与资金主数据"])

# ----------------------------------------------------------------------- 编号
@router.get("/sequences", response_model=list[schemas.SequenceOut])
def list_sequences(
    db: Session = Depends(get_db),
    user: CurrentUser = manage_order_types,
) -> list[schemas.SequenceOut]:
    del user
    result: list[schemas.SequenceOut] = []
    for sequence in foundation_list_sequences(db):
        next_number = ""
        try:
            # 序列行已随列表取出，直接按同一口径格式化；
            # 逐行 peek_number 会把已加载的行再回查一遍（实测 16 条冗余 SELECT）。
            next_number = format_next_number(
                sequence_key=sequence.sequence_key,
                prefix=sequence.prefix,
                padding=sequence.padding,
                current_value=sequence.current_value,
            )
        except Validation:
            next_number = f"<已达上限 {sequence_max(sequence.padding)}>"
        result.append(
            schemas.SequenceOut(
                sequence_key=sequence.sequence_key,
                prefix=sequence.prefix,
                padding=sequence.padding,
                current_value=sequence.current_value,
                next_number=next_number,
            )
        )
    return result
