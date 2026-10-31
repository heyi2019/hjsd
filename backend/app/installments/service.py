"""installments.service：分期合约建档 / 还款 / 结清 / 回收的统一入口。

本模块是兼容层（facade），只做符号再导出，不含业务逻辑：
- 共用工具 → `app.installments._shared`
- 建档与列表 → `app.installments.create`
- 还款/减免/展期 → `app.installments.repayment`
- 提前结清/违约 → `app.installments.settlement`
- 回收/出售/交付/逾期 → `app.installments.recovery`
"""
from __future__ import annotations

from ._shared import (
    _add_months,
    _merge_form_extra,
    _non_negative,
    _positive,
    _required_text,
    get_installment,
    total_receivable,
)
from .create import (
    _normalize_schedule,
    _service_fee_from_snapshot,
    create_installment,
    link_recovered_sale,
    list_installments,
)
from .recovery import (
    deliver,
    list_dispositions,
    mark_overdue,
    record_sale,
    recover_account,
)
from .repayment import (
    _pick_schedule,
    cancel_installment,
    extend_schedule,
    pay,
    waive_schedule,
)
from .settlement import mark_default, settle_early

__all__ = [
    "_add_months",
    "_merge_form_extra",
    "_non_negative",
    "_normalize_schedule",
    "_pick_schedule",
    "_positive",
    "_required_text",
    "_service_fee_from_snapshot",
    "cancel_installment",
    "create_installment",
    "deliver",
    "extend_schedule",
    "get_installment",
    "link_recovered_sale",
    "list_dispositions",
    "list_installments",
    "mark_default",
    "mark_overdue",
    "pay",
    "recover_account",
    "record_sale",
    "settle_early",
    "total_receivable",
    "waive_schedule",
]
