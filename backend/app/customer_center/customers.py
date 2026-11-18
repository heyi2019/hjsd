"""customer_center.customers：客户档案的建档、查询、变更、合并与参与方校验。

规则来源：CUS-01。

- 客户 `CUS0001` 编号域独立，创建后不可改、不可复用；
- 联系方式非唯一：重复只产生候选，**不拦截**；
- 停用 / 已合并对象不可作为新订单参与方（`CUSTOMER_DISABLED`）；
- 合并仅管理员：来源置 `MERGED`，迁移参与关系，保留原编号与审计。

实现已拆至 `customer_center/customer_ops/`（queries / writes）；本文件保留整合出口，
调用方无需改动。
"""
from __future__ import annotations
from app.customer_center.customer_ops.queries import (
    _customer_list_stmt, count_customers, get_customer, list_customers, summarize_customers,
)
from app.customer_center.customer_ops.writes import (
    create_customer, set_customer_status, update_customer,
)
__all__ = [
    "create_customer","list_customers","count_customers","summarize_customers",
    "_customer_list_stmt","get_customer","update_customer","set_customer_status",
]
