"""shared：跨业务域共享的领域原语（无业务归属，但被多个域共同依赖）。

这一层存在的唯一理由：**消除业务域之间的横向依赖**。

判据（三个都满足才归此层）：
1. 被 ≥2 个业务域直接引用；
2. 自身不属于任何一个业务域（无该域专属的表/接口/状态机）；
3. 只依赖 core（技术底座）与 domain（ORM），不反向依赖任何业务域。

现存成员与原归位：
- `order_amounts`：订单收入/支出/利润归集口径。原在 `app/orders/amounts.py`，
  被 orders / reporting / finance / parties / policy / value_added_services 六域引用，
  放在 orders 下导致 parties、policy 反向依赖 orders（形成环）。归位后
  `orders ↔ parties`、`orders ↔ policy` 两条双向边同时断开。
  **权威口径不变**：利润仍以本模块 `order_cashflow_profit` 为唯一权威。
- `form_values`：实体扩展字段（form_extra）的读写与校验。原在 `app/parties/fields.py`，
  被 orders / foundation / stocks / finance / reporting / value_added_services 引用，
  放在 parties 下导致这六个域全部横向依赖 parties。归位后这些边全部指向 shared。

禁止事项：
- shared 不得 import 任何业务域（orders / parties / finance / ...），否则只是把环挪了个位置；
- shared 不得写库业务状态（只做计算与字段读写，不产生业务单据）。
"""
