# 宜游轩 ERP · API 接口规范 v1.0

> 基础路径：`/api/v1`。金额以字符串传输，如 `"1234.50"`；时间使用 ISO 日期；所有写接口由 Service 事务执行。

> **实现优先级**：接口必须先满足 PRD 与功能规格。历史导入属于 P2，不得为兼容旧数据改变新单请求结构、状态机或核算规则。

## 1. 公共约定

- 成功：`200/201`；校验失败：`422`；状态冲突：`409`；不存在：`404`。客户联系方式默认脱敏；读取完整联系方式须 `customer.contact.read`，修改须 `customer.contact.write`，合并须 `customer.merge`。
- 响应错误：`{ "code": "POOL_ROUTE_MISSING", "message": "业务 HS 未配置 PROFIT 资金池", "details": {} }`。
- 列表筛选参数按各端点的请求签名执行；日期报表支持 `from` / `to`，订单和资金接口的可用筛选以 Swagger 为准，不假定所有列表都有分页参数。

## 2. 端点

| 模块 | 方法与路径 | 用途 |
|---|---|---|
| 认证 | POST `/auth/login`、GET `/auth/me`、POST `/auth/change-password`、POST `/auth/logout` | 登录、当前用户、改密、会话注销 |
| 池/业务 | GET/POST `/pools`，PATCH `/pools/{id}`、PATCH `/pools/{id}/status`、GET `/pools/{id}/balance` | 创建、停用、查看池及余额；有流水池禁止删除 |
| 业务主数据 | GET/POST `/order-types`，PATCH `/order-types/{id}`、PATCH `/order-types/{id}/active`，GET `/order-types/{id}/routes`、POST `/order-types/{code}/routes` | 业务类型和资金路由；业务类型可扩展 |
| 客户 | GET/POST `/customers`，GET/PATCH `/customers/{id}`，PATCH `/customers/{id}/status`，POST `/customers/{id}/merge` | 客户档案、重复候选、状态、合并与订单参与关系 |
| 合作方 | GET/POST `/counterparties`，PATCH `/counterparties/{id}`，PATCH `/counterparties/{id}/status` | 同行、供货方、平台等非客户对手方主数据 |
| 订单 | GET/POST `/orders`，GET/PATCH `/orders/{id}`，POST `/orders/{id}/cancel` | 创建、编辑、作废订单及读取事件时间线 |
| 事件 | POST `/orders/{id}/events` | BUY/COST/SELL/PAYMENT/DELIVER/CANCEL；动钱事件自动生成 cashflow，DELIVER 不生成 |
| 账号 | GET `/accounts`、GET `/accounts/inventory`、GET `/accounts/{id}/execution-detail`、PATCH `/accounts/{id}` | 查看库存、执行明细和维护账号；新账号只随工作台订单创建 |
| 分期 | GET/POST `/installments`，GET `/installments/{id}/schedules`，POST `/installments/{id}/payments`、`/settle-early`、`/default`、`/deliver`、期次 `/waive` / `/extend`，POST `/installments/mark-overdue` | `contract_type`=STOCK_SALE/ADVANCE_PURCHASE；HS 分期出售或 DFQ 代分期的计划、收款、逾期、换绑 |
| 人员/团队 | GET/POST/PATCH `/users`、POST `/users/{id}/reset-password`，GET/POST/PATCH `/teams` | 人员、角色、数据范围、团队与停用；停用有进行中订单时，PATCH 必须携带 `handover_user_id` 或非空 `handover_note`；角色不另设 `/roles` 资源 |
| 返点 | GET/POST `/rebates`，GET/POST `/rebates/{id}/settlements`，POST `/rebates/{id}/settlements/{settlement_id}/reverse` | 返点记录、分次到账、冲销与现金流 |
| 押金 | GET/POST `/deposits`，POST `/deposits/{id}/returns`、`/losses` | 缴纳、部分退回、损失与状态 |
| 流水/对账 | GET/POST `/cashflows`，POST `/cashflows/{id}/approve`、`/reject`、`/reverse`；GET/POST `/reconciliations`，POST `/reconciliations/{id}/resolve` | 查询与受控审核；订单事件来源流水不可手工修改；划转由 `/transfers` 原子生成成对流水 |
| 划转 | POST `/transfers`、POST `/transfers/{transfer_id}/repair` | 原子生成同一 `transfer_id` 下的 INTERNAL 转出/转入流水；异常修复须走修复接口 |
| 报表 | GET `/reports/inventory-health`、`/monthly-pnl`、`/commission`、`/business-pnl`、`/daily-funds`、`/order-profit` | R1–R5；当前返回 JSON，库存 CSV 导出由前端基于当前权限数据生成 |
| 异常 | GET `/quality/exceptions` | 未路由、单边划转、负可用余额、逾期、库存缺失、未关联返点等质量异常 |
| 活字段 | GET/POST `/field-definitions`，PATCH `/field-definitions/{id}/active`，DELETE `/field-definitions/{id}` | 定义、停用、排序；有历史值的字段不可删除 |
| 经营规则 | GET/POST `/policies`，GET `/policies/{id}/versions`，POST `/policies/{id}/versions`，PATCH/POST `/policy-versions/{id}`、`/approve` | 规则版本、审批、快照与多人利润分配；订单分配使用 `/orders/{id}/profit-allocations` |
| 历史导入 | POST/GET `/imports/batches`，GET `/imports/batches/{id}/rows|preview|reconciliation`，POST 映射、跳过、提交、回滚、更正 | P2 标准导入与复核，不改变新单模型 |
| 审计 | GET `/audit-logs`、`/audit-logs/actions` | 按对象、人员、日期查询受控操作记录 |

## 3. 关键请求

### 创建订单
`POST /orders`
```json
{"order_type":"HS","trade_date":"2026-10-04","account_id":12,"customer_roles":[{"customer_id":10,"role":"SELLER"},{"customer_id":11,"role":"BUYER"}],"counterparty_roles":[]}
```

返回包含 `order_no`。HS 必须使用 `account_id` 关联库存账号；DFQ 只填写 `account_snapshot` 中的游戏账号文本，禁止关联库存 `account_id`；DG 禁止关联工作室库存账号，TH 使用订单账号快照且不关联库存。订单角色必须符合业务类型，且停用客户/合作方不可引用。TH 同行写 `counterparty_roles:PEER`，DFQ 供货方写 `SUPPLIER`；不得把同行或供货方写入客户。创建分期合约时，`contract_type=STOCK_SALE` 仅接受已买入在库的 HS 订单，`ADVANCE_PURCHASE` 仅接受 DFQ 订单。

### 客户与合作方

`POST /customers`
```json
{"display_name":"小周","contact_name":"周某","wechat":"zhou123","qq":"123456","phone":"13800000000","source":"老客转介绍","tags":["复购"],"owner_id":3,"note":"偏好苹果区","extra_values":{"budget":"3000"}}
```

固定字段为 `display_name/contact_name/wechat/qq/phone/source/tags/owner_id/note`；`extra_values` 仅接收当前启用且 `entity_type=customer` 的活字段。返回可选 `duplicate_candidates`（微信号、QQ、手机号命中），不会阻止创建。`POST /customers/{id}/merge` 请求 `{"target_customer_id": 18,"reason":"同一微信号"}`，仅管理员可操作，来源客户置为 `MERGED`。

`POST /counterparties` 请求固定使用 `display_name/type/contact_name/wechat/qq/phone/note`；`type` 为 `PEER/SUPPLIER/PLATFORM`。订单创建、修改或客户/合作方停用时，如参与关系非法，返回 `422`：`PARTICIPANT_ROLE_INVALID`、`CUSTOMER_DISABLED` 或 `COUNTERPARTY_DISABLED`。

### 创建事件
`POST /orders/{id}/events`
```json
{"event_type":"BUY","amount":"1200.00","portion":"PRINCIPAL","occurred_on":"2026-10-04","pool_id":1,"counterparty":"同行A"}
```

成功后返回 event、派生 cashflow、重算后的订单摘要。TRANSFER 不允许由此接口单条创建。

### 分期收款与返点结算

- 分期收款（HS 分期出售或 DFQ 代分期）：`PAYMENT`，须同步更新 installment.paid，累计不得超过总应收。
- 返点结算：`{"settled_on":"2026-10-04","gross_amount":"100","platform_fee":"5","net_amount":"95","pool_id":2}`；净额自动入池。
