"""shared：跨业务域共享的领域原语（无业务归属，但被多个域共同依赖）。

这一层存在的唯一理由：**消除业务域之间的横向依赖**。

判据（三个都满足才归此层）：
1. 被 ≥2 个业务域直接引用；
2. 自身不属于任何一个业务域（无该域专属的表/接口/状态机）；
3. 只依赖 core（技术底座）与 domain（ORM），不反向依赖任何业务域。

现存成员与原归位：
- `order_amounts`：订单收入/支出/利润归集口径。原在 `app/orders/amounts.py`，
  被 orders / reporting / finance / customer_center / policy / installments 六域引用，
  放在 orders 下导致 customer_center、policy 反向依赖 orders（形成环）。归位后
  `orders ↔ customer_center`、`orders ↔ policy` 两条双向边同时断开。
  **权威口径不变**：利润仍以本模块 `order_cashflow_profit` 为唯一权威。
- `form_values`：实体扩展字段（form_extra）的读写与校验。原在 `app/customer_center/fields.py`，
  被 orders / field_definitions / stocks / finance / reporting / installments 引用，
  放在 customer_center 下导致这六个域全部横向依赖 customer_center。归位后这些边全部指向 shared。
- `order_access`：带可见性校验的订单读取，以及订单关联客户 ID 查询的注册点。读订单部分原在
  `app/orders/_shared.py`，关联客户查询原在 `app/business/orders/queries.py`；被 business /
  customers / finance 引用。关联客户查询的实现口径（_order_list_stmt / _mine_order_condition）
  必须留在 orders，故采用注册点转发——orders 加载时注册实现，customers 只读调用共享原语，
  既断 `customers -> business` 反向边，又保持口径单一权威。

禁止事项：
- shared 不得 import 任何业务域（orders / customer_center / finance / ...），否则只是把环挪了个位置；
- shared 不得写库业务状态（只做计算与字段读写，不产生业务单据）。
"""
