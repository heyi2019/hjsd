"""parties.service：客户、线索、合作方与表单扩展字段的统一 Service 入口。

本模块是兼容层（facade），只做符号再导出，不含业务逻辑：
- 客户相关 → `app.parties.customers`
- 需求/线索 → `app.parties.leads`
- 合作方 → `app.parties.counterparties`
- 扩展字段 → `app.parties.fields`

外部既有 `from app.parties import service as parties_service` 的调用方式保持不变。

规则来源：CUS-01、BAS-02-05、BAS-04、《ERP_接口错误码与状态机_v1.0.md》。
"""
from __future__ import annotations

from ._common import mask_id, mask_phone, to_customer_out
from .counterparties import (
    assert_counterparty_usable,
    create_counterparty,
    get_counterparty,
    list_counterparties,
    set_counterparty_status,
    update_counterparty,
)
from .customer_detail import (
    get_customer_activity_summary,
    get_customer_detail,
)
from .customer_merge import (
    assert_customer_usable,
    duplicate_candidates,
    merge_customers,
)
from .customers import (
    _customer_list_stmt,
    count_customers,
    create_customer,
    get_customer,
    list_customers,
    set_customer_status,
    update_customer,
)
from .fields import get_extra_values, get_extra_values_bulk, set_extra_values
from .leads import (
    _get_lead_for_user,
    close_lead,
    convert_lead,
    create_lead,
    get_lead,
    list_leads,
    update_lead,
)

__all__ = [
    "_customer_list_stmt",
    "_get_lead_for_user",
    "assert_counterparty_usable",
    "assert_customer_usable",
    "close_lead",
    "count_customers",
    "create_counterparty",
    "create_customer",
    "create_lead",
    "convert_lead",
    "duplicate_candidates",
    "get_counterparty",
    "get_customer",
    "get_customer_activity_summary",
    "get_customer_detail",
    "get_extra_values",
    "get_extra_values_bulk",
    "get_lead",
    "list_counterparties",
    "list_customers",
    "list_leads",
    "mask_id",
    "mask_phone",
    "merge_customers",
    "set_counterparty_status",
    "set_customer_status",
    "set_extra_values",
    "to_customer_out",
    "update_counterparty",
    "update_customer",
    "update_lead",
]
