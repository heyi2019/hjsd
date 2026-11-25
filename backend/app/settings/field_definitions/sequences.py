"""业务编号序列服务。"""
from __future__ import annotations
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.domain.form_scopes import FORM_SCOPES
from app.domain.options import OptionSet
from app.domain.trade import OrderFormField
from app.shared.numbering import allocate_number
from app.shared.option_codes import normalize_option_prefix, option_sequence_key
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


def option_sequence_descriptions(session: Session) -> dict[str, tuple[str, str]]:
    """根据现有配置查找内部序列对应的显示名称与实际编码前缀。"""
    descriptions = {
        option_sequence_key("fund-pool"): ("资金账户", "pool_"),
        option_sequence_key("team"): ("团队", "team_"),
    }
    for code, label in session.execute(select(OptionSet.code, OptionSet.label)):
        try:
            prefix = normalize_option_prefix(code)
        except ValueError:
            continue
        descriptions[option_sequence_key(f"option-set:{code}")] = (label, f"{prefix}_")

    scope_labels = {scope.code: scope.label for scope in FORM_SCOPES}
    for scope, key, label in session.execute(select(
        OrderFormField.order_type_code, OrderFormField.field_key, OrderFormField.label,
    )):
        try:
            prefix = normalize_option_prefix(key)
        except ValueError:
            continue
        descriptions[option_sequence_key(f"form:{scope}:{key}")] = (
            f"{scope_labels.get(scope, scope)} · {label}", f"{prefix}_",
        )
    return descriptions
