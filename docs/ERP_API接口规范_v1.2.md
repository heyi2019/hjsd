# 宜游轩 ERP · API 接口规范 v1.2（当前实现）

## 版本记录

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v1.2 | 2026-11-01 | 删除已不存在的 /period-locks 端点；补记 lists 列表列配置模块；更正前端 catalog.ts 已按域拆分；订单与合约约束去除 DFQ；旧版 v1.1 已下线，需要时从 git 历史追溯 |


> 基础路径：`/api/v1`。金额以字符串传输，如 `"1234.50"`；时间使用 ISO 日期；所有写接口由 Service 事务执行。

> **实现优先级**：本文以当前后端 OpenAPI 实现为准，PRD 与功能规格用于解释业务语义。导入属于 P2，不得为兼容旧数据改变新单请求结构、状态机或核算规则。

> **修订（2026-11-01）**：删除已不存在的 `/period-locks` 端点（账期锁定整体移除）；补记 `lists` 列表列配置模块；更正前端 `catalog.ts` 已按域拆分。

> **动作模型（2026-11-10）**：业务事件、资金明细和页面动作的边界以 [ERP 系统动作定义 v1.0](ERP_系统动作定义_v1.0.md) 为准。分期回款、退款和经营支出均通过资金明细记录，不新增 `PAYMENT`、`REFUND` 或 `COST` 订单业务事件。

> **本次升级（2026-10-28）**：高频列表 `/orders`、`/customers`、`/stocks` 改为统一分页对象；旧的裸数组响应不再属于 v1.1 契约。前端领域 API 会自动翻页后向页面提供数组，但后端接口本身只接受/返回新契约。旧版独立字段定义接口已下线，统一使用订单表单字段配置。

## 1. 公共约定

| 约定项 | 当前规范 |
|---|---|
| 成功与错误状态码 | 成功：`200/201`；认证失败：`401`；禁止访问：`403`；资源不存在：`404`；方法不允许：`405`；状态冲突：`409`；请求参数或业务校验失败：`422`；登录限流：`429`。 |
| 客户联系方式 | 默认脱敏；读取完整联系方式须 `customer.contact.read`；修改须 `customer.contact.write`；合并须 `customer.merge`。 |
| 错误响应 | 所有错误统一返回 `{ "code": "...", "message": "...", "details": {} }`；参数校验失败时 `details.errors` 为字段错误数组。 |
| 错误示例 | `{ "code": "POOL_ROUTE_MISSING", "message": "业务 HS 未配置 PROFIT 资金池", "details": {} }`。 |
| 请求追踪 | 请求可携带 `X-Request-ID`，仅接受最长 64 字符的可打印字符；未携带或格式不合法时服务端生成，并始终在响应头返回。受控动作审计记录保存该请求号，审计查询回显 `request_id`。 |
| 列表筛选 | 按各端点请求签名执行；日期报表支持 `from` / `to`。只有标注为“分页列表”的端点承诺 `limit/offset`，其他列表不应自行推断分页参数。 |
| 分页响应 | 统一返回 `{ "items": [], "total": 0, "limit": 100, "offset": 0 }`，不再返回裸数组。当前适用 `/orders`、`/customers`、`/stocks`；`limit` 范围为 1–500，`offset` 从 0 开始。 |
| 认证 | 统一使用 `Authorization: Bearer <JWT>`；仅 `app_env=development/dev/local` 接受 `X-Dev-User`（`admin/operator/finance/auditor/viewer`）作为开发态身份切换，其他环境一律拒绝该请求头。 |
| 接口发现 | 仅 development/dev/local 暴露 `/docs`、`/redoc`、`/openapi.json`；其他环境关闭交互式文档和 OpenAPI 发现接口。 |

## 2. 端点

| 模块 | 方法与路径 | 用途 |
|---|---|---|
| 健康 | GET `/`、GET `/health` | 引擎信息、数据库连通性与 SQLite 运行参数 |
| 认证 | POST `/auth/login`、GET `/auth/me`、POST `/auth/change-password`、POST `/auth/logout` | 登录、当前用户、改密、会话注销 |
| 主数据 | `GET/POST /pools`；`PATCH/DELETE /pools/{pool_id}`；`PATCH /pools/{pool_id}/status`；`GET /pools/{pool_id}/balance`；`GET/POST /order-types`；`PATCH /order-types/{order_type_id}`、`/active`；`GET/POST /game-types`；`PATCH /game-types/{game_type_id}`、`/active`、`/default`；`DELETE /game-types/{game_type_id}`；`GET/POST /option-sets`；`GET/PUT/DELETE /option-sets/{code}`；`GET /sequences` | 资金池、业务类型、游戏类型、选项集及状态维护 |
| 路由 | `GET /order-types/{order_type_id}/routes`；`POST /order-types/{code}/routes`；`GET /order-types/{code}/routes/impact-preview` | 业务类型到资金池的过账路由与影响预览；当前无路由 PATCH |
| 客户/合作方 | `GET/POST /customers`；`GET/PATCH /customers/{customer_id}`；`GET /customers/{customer_id}/detail`；`PATCH /customers/{customer_id}/status`；`POST /customers/{customer_id}/merge`；`GET/POST /counterparties`；`GET/PATCH /counterparties/{counterparty_id}`；`PATCH /counterparties/{counterparty_id}/status` | 客户、同行、供货方、平台等主体资料；客户列表为分页列表 |
| 客户需求 | `GET/POST /leads`；`GET/PATCH /leads/{lead_id}`；`POST /leads/{lead_id}/convert`、`/close` | 代蹲、代出、定找需求池 |
| 订单 | `GET/POST /orders`；`GET/PATCH /orders/{order_id}`；`POST /orders/{order_id}/cancel`、`/events`；`GET/POST /orders/{order_id}/links`；`DELETE /orders/{order_id}/links/{link_id}` | 订单、事件、关联订单；订单列表为分页列表 |
| 订单规则 | GET `/orders/{id}/policy-snapshot`；GET/PUT `/orders/{id}/profit-allocations` | 订单规则快照与多人利润分配 |
| 库存账号 | `GET /stocks`；`PATCH /stocks/{account_id}`；`GET /stocks/inventory`、`/stocks/{account_id}/execution-detail`；`PATCH /stocks/{account_id}/execution-edit` | 账号台账、库存健康、执行明细与受控编辑；账号列表为分页列表 |
| 分期 | `GET/POST /installments`；`POST /installments/mark-overdue`；`GET /installments/{installment_id}/schedules`、`/dispositions`；`POST /installments/{installment_id}/payments`、`/recover`、`/resale`、`/settle-early`、`/default`、`/deliver`、`/cancel`；`POST /installments/{installment_id}/schedules/{period_no}/waive`、`/extend` | 分期合约、期次、收款与处置 |
| 人员/团队 | `GET/POST /users`；`PATCH /users/{user_id}`；`POST /users/{user_id}/reset-password`；`GET/POST /teams`；`PATCH /teams/{team_id}` | 人员、角色、数据范围与团队 |
| 资金 | `GET/POST /cashflows`；`POST /cashflows/{cashflow_id}/approve`、`/reject`、`/reverse`；`GET/POST /deposits`；`POST /deposits/{deposit_id}/returns`、`/cancel`、`/losses`；`GET/POST /rebates`；`GET /rebates/overdue`、`GET /rebates/{rebate_id}`；`PATCH/DELETE /rebates/{rebate_id}`；`GET/POST /reconciliations`；`POST /reconciliations/{reconciliation_id}/resolve` | 资金流水、押金、返点与对账；返点登记即完成收入确认，不再使用分次结算端点 |
| 划转 | POST `/transfers`、`/transfers/{transfer_id}/repair` | 原子资金划转与单边划转修复。**账期锁定能力已整体移除**：原 `GET/POST /period-locks` 端点、`period_locks` 表、`finance.period.lock` 权限与「锁定账期」入口均不存在，调用将返回 404 |
| 报表 | GET `/reports/inventory-health`、`/monthly-pnl`、`/commission`、`/business-pnl`、`/finance-dimensions`、`/daily-funds`、`/order-profit`；GET `/reports/{report_name}/export.csv` | 库存健康、损益、佣金、资金、订单利润与导出 |
| 质量 | `GET /quality/exceptions`、`/metrics`、`/issues`、`/issues/{issue_id}`；`POST /quality/scan`、`/issues`、`/issues/{issue_id}/close`、`/issues/batch-close`；`PATCH /quality/issues/{issue_id}` | 数据质量异常与指标 |
| 搜索/通知 | `GET /search`、`/notifications`；`POST /notifications/{notification_id}/read`、`/notifications/sync-overdue-rebates` | 全局搜索与站内通知 |
| 附件 | `GET/POST /attachments`；`GET /attachments/{attachment_id}/download`；`DELETE /attachments/{attachment_id}` | 订单、事件、资金、分期、质量异常附件 |
| 列表列配置 | `GET /list-columns`；`GET /list-columns/custom-fields`；`PUT/DELETE /list-columns/{scope}`；`POST /list-columns/{scope}/custom`；`DELETE /list-columns/{scope}/custom/{column_key}` | 各列表作用域的列显示配置与自定义列定义；自定义列键为 `extra:{field_key}`，显示状态复用 `list_column_configs`（不另建状态表）；「恢复默认」只清显示配置、不删列定义 |
| 表单扩展字段 | `GET/POST /order-form-fields`；`GET /order-form-fields/scopes`；`GET/PATCH/DELETE /order-form-fields/{field_id}`；`PATCH /order-form-fields/{field_id}/active` | 统一的订单/库存/客户等表单字段定义、启停、排序与作用域；值落在实体 `form_extra` |
| 经营规则 | `GET/POST /policies`；`GET/POST /policies/{definition_id}/versions`；`GET /policies/{definition_id}`；`PATCH /policy-versions/{version_id}`；`POST /policy-versions/{version_id}/approve`、`/supersede`、`/policies/versions/expire-sweep`；`GET /policy-versions/resolve` | 规则版本、审批、快照与解析 |
| 导入 | `GET/POST /imports/batches`；`GET /imports/batches/{batch_id}/rows`、`/preview`、`/reconciliation`；`POST /imports/rows/{row_id}/map`、`/skip`、`/unlinked-transfer`；`POST /imports/batches/{batch_id}/commit`、`/rollback`、`/corrections`、`/reject` | P2 标准导入与复核 |
| 审计 | GET `/audit-logs`、`/audit-logs/actions`、`/audit-logs/stats` | 按对象、人员、日期查询受控操作记录 |

### 2.1 分页列表

以下三个列表已经切换为严格分页契约，不再返回裸数组：

| 接口 | 默认 | 最大 | 常用筛选 |
|---|---:|---:|---|
| `GET /orders` | `limit=100` | 500 | `order_type`、`status`、交易日期、负责人、资金池、关键词 |
| `GET /customers` | `limit=100` | 500 | `keyword`、`status` |
| `GET /stocks` | `limit=100` | 500 | `status` |

请求示例：`GET /api/v1/orders?limit=20&offset=40&status=ACTIVE`

响应示例：

```json
{
  "items": [{"id": 41, "order_no": "HS20261000041"}],
  "total": 127,
  "limit": 20,
  "offset": 40
}
```

`total` 是应用当前权限范围和筛选条件下的总数；`offset + items.length >= total` 时表示已经到达末页。前端不得把 `limit` 当成总数，也不得根据“返回数量小于默认值”推断未授权数据不存在。

## 3. 关键请求

### 创建订单
`POST /orders`
```json
{"order_type":"HS","trade_date":"2026-10-04","account_id":12,"customer_roles":[{"customer_id":10,"role":"SELLER"},{"customer_id":11,"role":"BUYER"}],"counterparty_roles":[]}
```

返回包含 `order_no`。HS 必须使用 `account_id` 关联回收库存；DG 使用 `account_id` 关联寄售库存；TH 使用 `account_id` 关联提号库存（PICKUP）。订单角色必须符合业务类型，且停用客户/合作方不可引用。TH 同行写 `counterparty_roles:PEER`，DG 寄售方写 `CONSIGNOR`；不得把同行或供货方写入客户。创建分期合约时，`contract_type=STOCK_SALE` 仅接受已买入在库的 HS 订单，`PICKUP_SALE` 仅接受 TH 订单，`CONSIGNMENT_SALE` 仅接受 DG 订单。

### 客户与合作方

`POST /customers`
```json
{"display_name":"小周","contact_name":"周某","wechat":"zhou123","qq":"123456","phone":"13800000000","source":"老客转介绍","tags":["复购"],"owner_id":3,"note":"偏好苹果区","extra_values":{"budget":"3000"}}
```

固定字段为 `display_name/contact_name/wechat/qq/phone/source/tags/owner_id/note`；客户接口的 `extra_values` 仅接收当前表单字段配置允许的扩展键，并写入客户扩展值。订单、账号等实体的扩展值统一通过各自请求中的 `form_extra` 传输，并在创建/列表/详情响应中返回。返回可选 `duplicate_candidates`（微信号、QQ、手机号命中），不会阻止创建。`POST /customers/{id}/merge` 请求 `{"target_customer_id": 18,"reason":"同一微信号"}`，仅管理员可操作，来源客户置为 `MERGED`。

`POST /counterparties` 请求固定使用 `display_name/type/contact_name/wechat/qq/phone/note`；`type` 为 `PEER/SUPPLIER/PLATFORM`。订单创建、修改或客户/合作方停用时，如参与关系非法，返回 `422`：`PARTICIPANT_ROLE_INVALID`、`CUSTOMER_DISABLED` 或 `COUNTERPARTY_DISABLED`。

### 创建事件
`POST /orders/{id}/events`
```json
{"event_type":"BUY","amount":"1200.00","portion":"PRINCIPAL","occurred_on":"2026-10-04","pool_id":1,"counterparty":"同行A"}
```

成功后返回 event、派生 cashflow、重算后的订单摘要。TRANSFER 不允许由此接口单条创建。

### 分期收入与返点登记

- 分期收入（业务名称统一为「分期出售」；合约类型按订单类型编码：`HS + STOCK_SALE`、`TH + PICKUP_SALE`、`DG + CONSIGNMENT_SALE`）：通过 `CASHFLOW` 记录 `CASHFLOW_DIRECTION=IN`、`CASHFLOW_REASON=INSTALLMENT_PAYMENT`，同步更新 `installment.paid`，累计不得超过总应收；不新增 `PAYMENT` 订单事件。
- 返点登记：`{"rebate_type":"BUY","base_amount":"100","collected_on":"2026-10-04","pool_id":2}`；登记即关联一笔 `IN` 返点收入资金明细。如产生平台手续费，另登记 `OUT` 资金明细，不从返点收入中改写净额。

## 4. 前后端联调与治理

- 前端统一通过 `frontend/src/shared/api/client.ts` 发起请求；领域路径与响应类型按业务域拆分在 `frontend/src/shared/api/*.api.ts`（`catalog.ts` 现为 18 行再导出兼容层，`types.ts` 承载纯类型），页面不应直接拼接业务 URL。
- `GET` 请求由客户端做短时并发去重与 SWR 缓存；成功的写请求会清空 GET 缓存。分页列表由领域 API 按 `limit/offset` 自动翻页，页面层只接收业务数组。
- 后端路由必须声明 `response_model`；错误、参数校验和权限异常统一由应用工厂转换为 `{code,message,details}`。新增或修改接口必须同步契约测试与本文档。
- OpenAPI 以 development 环境的 `/openapi.json` 为机器可读事实源；Markdown 只解释业务约束，不替代 OpenAPI 的字段级定义。
