# 宜游轩 ERP · 数据字典 v2.0

| 项 | 内容 |
|---|---|
| 文件编号 | ERP_数据字典_v2.0 |
| 运行域 | 工作经营 / 黑金时代 ERP |
| 阅读对象 | 后端开发、数据治理、运维交付 |
| 编写日期 | 2026-11-01 |
| 编写人 | WorkBuddy（依代码实测生成） |

**版本记录**

| 版本 | 日期 | 终态口径变更 |
|---|---|---|
| v1.0 | 2026-10-20 | 首版，覆盖 PRD v1.3 初期实现 |
| v2.0 | 2026-11-01 | 代分期 DFQ 整体下线；`capital_type` 收敛为 STOCK/ZERO；库存主表更名 `stocks`、编号改 `stock_no`(KU_)；`accounts` 表与接口域移除；新增业务字典、列表自定义列、编号序列与对账表；字段级全部按 ORM 实测对齐 |

> 旧版见 `docs/archive/ERP_数据字典_v1.0_已作废.md`（保留只读，不再维护）。

## 1. 文档边界

本字典定义**新业务的固定物理契约**，事实来源为 `backend/app/domain/` 下的 ORM 模型与 `app/domain/enums.py`。任何与本文冲突的旧 PRD、旧迁移说明、旧测试报告均以本文为准。

历史资料仅按迁移映射以参考记录导入；历史列、旧表和脏值**不得**扩展或改变以下结构。字段名一律取数据库物理名，表名一律取 `__tablename__`。

## 2. 静态表清单

ORM 模型共 **39 张表**，另有 Alembic 自建的 `alembic_version` 与迁移审计表 `db_version`（无 ORM 模型），合计 41 张物理表。

| 域 | 表 |
|---|---|
| 基础主数据 | `pools`、`order_type_defs`、`order_type_pools`、`document_sequences`、`game_type_options`、`audit_logs` |
| 参与方 | `customers`、`customer_leads`、`counterparties`、`order_customer_roles`、`order_counterparty_roles` |
| 经营规则 | `policy_definitions`、`policy_versions` |
| 交易 | `orders`、`order_events`、`order_links`、`stocks` |
| 分期 | `installments`、`installment_schedules`、`installment_dispositions` |
| 资金 | `cashflow`、`deposits`、`rebate_records`、`reconciliations` |
| 配置与展示 | `order_form_fields`、`order_form_section_labels`、`option_sets`、`list_column_configs`、`list_custom_columns` |
| 运营支撑 | `import_batches`、`import_rows`、`quality_issues`、`notifications`、`attachments` |
| 账号 | `users`、`teams`、`revoked_tokens` |

**已下线，禁止再引用**：`accounts`（原库存主表，现为 `stocks`）、`pool_accounts`（从未落地，资金只到池一级）、`period_locks`（未落地）、`field_definitions` / `entity_extra_values`（现为 `order_form_fields` + 各表 `form_extra`）、DFQ 相关的一切配置与编号域。

## 3. 固定枚举

### 3.1 业务分类

| 枚举 | 取值 | 约束 |
|---|---|---|
| `BusinessMode` | `SELF` / `DISTRIBUTION` | 库存账号所属业务模式 |
| `InventoryType` | `RECOVERY` / `PICKUP` / `CONSIGNMENT` | 库存来源类型 |
| `CapitalType` | `STOCK` / `ZERO` | 仅两值；`CREDIT` 已随代分期下线移除，存量单据不得新写 |
| `InstallmentContractType` | `STOCK_SALE` / `PICKUP_SALE` / `CONSIGNMENT_SALE` | 与业务一一对应：HS / TH / DG。`ADVANCE_PURCHASE` 已删除 |
| `ValueAddedService`（库存字段） | `STOCK_SALE` / `PICKUP_SALE` / `CONSIGNMENT_SALE` | 写在 `stocks.value_added_service`，标记该库存已进入分期链路 |

**业务 ↔ 池路由**（`order_type_pools`，种子固定，可在设置页停用不可改语义）

| 业务 | 名称 | capital_type | 本金路由 | 利润路由 |
|---|---|---|---|---|
| `HS` | 回收 | `STOCK` | `HJ_INVEST` / PRINCIPAL | `HJ_PROFIT` / PROFIT |
| `TH` | 提号 | `STOCK` | `HJ_INVEST` / PRINCIPAL | `HJ_PROFIT` / PROFIT |
| `DG` | 代挂 | `ZERO` | — | `HJ_PROFIT` / PROFIT + GROSS |

### 3.2 交易与状态

| 枚举 | 取值 |
|---|---|
| `OrderStatus` | `ACTIVE` / `INSTALLMENT` / `COMPLETED` / `CANCELLED` |
| `EventType` | `BUY` / `COST` / `SELL` / `PAYMENT` / `DELIVER` / `CANCEL` / `REFUND` |
| `OrderLinkType` | `SOURCE` / `FOLLOW_UP` |
| `LinkStatus` | `LINKED` / `UNLINKED` / `ORPHAN` / `UNLINKED_TRANSFER`（禁止 `AUTO_MATCHED`） |
| `AccountStatus` | `WAITING` / `SOLD` / `VOID` |
| `InventoryStatus` | `IN_STOCK` / `OUT_OF_STOCK` |

### 3.3 分期

| 枚举 | 取值 |
|---|---|
| `InstallmentStatus` | `PENDING` / `ACTIVE` / `OVERDUE` / `SETTLED` / `DELIVERED` / `DEFAULTED` / `CLOSED` / `CANCELLED` |
| `ScheduleStatus` | `PENDING` / `PARTIAL` / `PAID` / `OVERDUE` / `WAIVED` |
| `InstallmentDispositionAction` | `RECOVER` / `RESELL` |
| `DeliveryMode` | `PLATFORM_OPERATOR` / `CUSTOMER_SELF` |
| `CommissionMode` | `DEDUCT_FROM_SETTLEMENT` / `SEPARATE_PAYMENT` |
| `CommissionPayer` | `BUYER` / `CONSIGNOR` / `PLATFORM` |
| `AllocationRole` | `OWNER` / `BUYER` / `SALES` / `SERVICE` |

### 3.4 资金

| 枚举 | 取值 |
|---|---|
| `Nature` | `EXTERNAL_IN` / `BUSINESS_IN` / `BUSINESS_OUT` / `INTERNAL` |
| `FundNature` | `BUSINESS` / `EXTERNAL` / `INTERNAL` |
| `AccountingAttribute` | `SELF_REVENUE` / `SELF_DIRECT_COST` / `TH_DIRECT_COST` / `TH_REVENUE` / `SERVICE_REVENUE` / `ADDITIONAL_INCOME` / `ADDITIONAL_EXPENSE` / `OPERATING_EXPENSE` / `DEPOSIT` / `EXTERNAL_FUNDING` / `INTERNAL_TRANSFER` / `REVERSAL` / `REFUND` |
| `Direction` | `IN` / `OUT` |
| `CashflowStatus` | `PENDING` / `APPROVED` / `REJECTED` |
| `DepositStatus` | `PAID` / `PARTIALLY_RETURNED` / `RETURNED` / `LOST` / `CANCELLED` |
| `RebateType` | `BUY` / `SELL` |
| `RebateStatus` | `OPEN` / `PARTIALLY_SETTLED` / `SETTLED` / `VOID` |
| `ReconciliationStatus` | `OPEN` / `RESOLVED` |
| `PoolType` | `INVEST` / `PROFIT` / `OTHER` |
| `PoolOwnership` | `OWNED` / `CUSTODY` / `THIRD_PART`（后两者不计权益） |

`DFQ_PRINCIPAL` 已从 `AccountingAttribute` 移除；`TRANSFER` 不是事件类型，划转经 `cashflow.transfer_id` 成对登记。

### 3.5 参与方与运营

| 枚举 | 取值 |
|---|---|
| `CustomerStatus` | `ACTIVE` / `DISABLED` / `MERGED` |
| `LeadType` | `FIND_ACCOUNT` / `SELL_ACCOUNT` / `SPECIFIC_SEARCH` |
| `LeadStatus` | `OPEN` / `CONVERTED` / `CLOSED` |
| `CounterpartyType` / `CounterpartyRole` | `PEER` / `SUPPLIER` / `PLATFORM` |
| `CustomerRole` | `SELLER` / `BUYER` / `CONSIGNOR` / `INSTALLMENT_CUSTOMER` |
| `PolicyType` | `REBATE` / `COMMISSION` / `INSTALLMENT` / `WRITE_DOWN` / `REFUND` / `DG_MIXED` |
| `PolicyStatus` | `DRAFT` / `ACTIVE` / `EXPIRED` / `SUPERSEDED` |
| `PolicyScopeType` | `GLOBAL` / `ORDER_TYPE` / `USER` / `POOL` |
| `QualityIssueStatus` | `OPEN` / `IN_PROGRESS` / `CLOSED` |
| `ImportBatchStatus` | `DRAFT` / `MAPPED` / `COMMITTED` / `REJECTED` / `ROLLED_BACK` / `CORRECTED` |
| `ImportRowStatus` | `PENDING` / `MAPPED` / `UNMAPPED` / `IMPORTED` / `SKIPPED` / `ROLLED_BACK` |
| `EntityType`（活字段作用域） | `order` / `account` / `customer` / `installment` / `pool` / `cashflow` / `lead` / `counterparty` |
| `FieldType` | `TEXT` / `NUMBER` / `DATE` / `BOOLEAN` / `SELECT` / `MULTI_SELECT` |

## 4. 核心表

### 4.1 基础主数据

| 表 | 关键字段 | 约束 |
|---|---|---|
| `pools` | code, name, pool_type, ownership, status, note | 资金只到池一级，无子账户；code 不可改；有流水不可删 |
| `order_type_defs` | code, name, capital_type, sequence_prefix, sequence_key, is_active, sort_order, description | 种子仅 HS/TH/DG；停用不影响历史单据 |
| `order_type_pools` | order_type_id, pool_id, portion, fund_nature, priority, is_active | 一个 (业务, portion) 一条有效路由；显式池优先于默认 |
| `document_sequences` | sequence_key, prefix, padding, current_value | 见 §5 编号规则 |
| `game_type_options` | name, sort_order, is_active, is_default, channel_regions | 游戏类型主数据，随字典可增改；`is_default` 全局唯一 |
| `audit_logs` | occurred_at, actor, action, entity_type, entity_id, before_json, after_json, reason, request_id | 所有写路径必经；`action` 取 `AuditAction` 闭集 |

### 4.2 参与方

| 表 | 关键字段 | 约束 |
|---|---|---|
| `customers` | customer_no, display_name, contact_name, phone, wechat, qq, source, owner_id, status, tags, note, form_extra, merged_into_id, merged_reason | 联系方式非唯一；停用后不可用于新单；合并仅管理员，来源置 `MERGED` 并保留 `merged_into_id`，不删行 |
| `customer_leads` | lead_no, customer_id, request_type, budget, target, status, owner_id, converted_order_id, closed_reason, note | 不占用资金、不自动建单；转单后保留来源关系 |
| `counterparties` | counterparty_no, display_name, type, contact_name, phone, wechat, qq, source, status, note | 不与客户混用 |
| `order_customer_roles` | order_id, customer_id, role | `UNIQUE(order_id, customer_id, role)` |
| `order_counterparty_roles` | order_id, counterparty_id, role | `UNIQUE(order_id, counterparty_id, role)`；TH 同行、平台方从此关联 |

### 4.3 经营规则

| 表 | 关键字段 | 约束 |
|---|---|---|
| `policy_definitions` | policy_code, name, scope_type, scope_id, description, status | 闭集预置，不开放自由新建类型 |
| `policy_versions` | policy_definition_id, version, effective_from, effective_to, config(JSON), status, approved_by, approved_at, note | 已发布版本不可改不可删，只能新建版本；config 值一律字符串；保存即发布 |

### 4.4 交易

| 表 | 关键字段 | 约束 |
|---|---|---|
| `orders` | order_no, order_type, capital_type, trade_date, commission_mode, commission_payer, account_snapshot(JSON), account_id, status, policy_version_id, policy_snapshot, link_status, owner_id, note, form_extra | 汇总金额由事件派生，不落冗余列；HS/TH/DG 经 `account_id` 关联 `stocks`；代挂的 `commission_mode` / `commission_payer` 登记在订单头，不另设抽成公式 |
| `order_events` | event_no, order_id, event_type, amount, portion, occurred_on, pool_id, offset_event_id, delivery_mode, is_posted, posted_at, reason, refund_responsibility, note, form_extra, operator_user_ids | 有资金事件必须有池；`BUY`/`SELL` 按 `portion` 拆本金与利润；`REFUND` 责任方必填且金额 ≤ 已收 − 已退；`CANCEL` 走冲销不物理删；`is_posted` 控制过账时序 |
| `order_links` | source_order_id, target_order_id, relation_type, split_ratio, split_amount, note, created_by, updated_by | 关系分 `SOURCE` / `FOLLOW_UP`；拆单金额与比例二选一必须自洽 |
| `stocks` | game_type, business_mode, inventory_type, value_added_service, stock_no, game_account, game_password, channel_region, bound_phone, has_secondary, platform, status, inventory_status, inventory_entry_at, buy_date, cost_amount, account_description, account_images(JSON), note, form_extra | `stock_no`（`KU_` 五位）为库存主键语义编号；`game_account` 仅是文本，**不唯一**（同一账号可多次收购）；`game_password` 按既定裁决明文存储，不做加密或脱敏；滞销颜色由前端按 `buy_date` 计算，不落库；`status` 与 `inventory_status` 两轴并存——前者为账号生命周期（WAITING/SOLD/VOID），后者为库存在场状态（IN_STOCK/OUT_OF_STOCK） |

### 4.5 分期

| 表 | 关键字段 | 约束 |
|---|---|---|
| `installments` | inst_no, order_id, contract_type, policy_version_id, policy_snapshot, principal, down_payment, service_fee, periods, per_period_service_fee, per_period, final_period_adjustment, paid_amount, waived_amount, bad_debt_amount, status, delivery_mode, delivered_on, first_due_on, note, form_extra | 合约通过所属订单取得库存信息，不单存 account_id；合约类型必须与来源业务一致（HS→STOCK_SALE，TH→PICKUP_SALE，DG→CONSIGNMENT_SALE）；末期用 `final_period_adjustment` 吸收尾差；坏账单独累计 `bad_debt_amount`，不改原应收 |
| `installment_schedules` | installment_id, period_no, due_on, service_fee_rate, due_amount, received_amount, waived_amount, received_on, status | `UNIQUE(installment_id, period_no)`；每期可单独配服务费率；应收 = 当期本金 + 当期服务费；减免累计 `waived_amount` 且不改写原应收；展期只更新 `due_on`，不是独立状态 |
| `installment_dispositions` | installment_id, account_id, action, occurred_on, related_order_id, note | `RECOVER` 使账号回到 `IN_STOCK`；`RESELL` 必须关联新的已登记 `SELL` 订单；同一合约每类动作只能登记一次；契约状态不因处置新增取值 |

### 4.6 资金

| 表 | 关键字段 | 约束 |
|---|---|---|
| `cashflow` | flow_no, pool_id, occurred_on, nature, fund_nature, accounting_attribute, category, direction, amount, status, order_id, deposit_id, order_event_id, transfer_id, reversal_of_id, reviewed_by, reviewed_at, reversal_reason, note, form_extra | 必属池；三轴并存——`nature` 现金性质、`fund_nature` 资金属性、`accounting_attribute` 核算属性；事件派生流水一对一；冲销经 `reversal_of_id` 反向成对，不删除原流水；内部划转经 `transfer_id` 两腿成对；运营消耗 `category` 必须写 `房租` / `日用` |
| `deposits` | pool_id, counterparty_id, source_order_id, paid_amount, returned_amount, lost_amount, status, paid_on, expected_release_on, released_on, lost_on, note | 可退押金不进损益，必须关联现金流；不单独生成押金编号 |
| `rebate_records` | rebate_no, source_order_id, rebate_type, channel, rate, base_amount, policy_version_id, policy_snapshot, link_status, status, collected_on, note, operator_user_ids, form_extra | 新记录来源订单必填；费率与规则版本快照一并固化；存量 19 笔允许 `UNLINKED` |
| `rebate_settlements`（已下线） | — | 2026-11-05 裁决：返点登记即收入确认，金额唯一取 `rebate_records.base_amount`，不再有分次到账 / 手续费 / 冲销子记录；新库不建此表，已有库历史表保留不 drop |
| `reconciliations` | pool_id, reconciled_on, account_label, system_balance, statement_balance, difference, status, reason, unmatched_flow_ids(JSON), resolved_by, resolved_at, note | 判重键 `(pool_id, reconciled_on, account_label)`；系统余额 = 池内已审核流水有符号和 |

### 4.7 配置与展示

| 表 | 关键字段 | 约束 |
|---|---|---|
| `order_form_fields` | order_type_code, field_key, label, field_type, options, flow_direction, required, required_when, is_active, sort_order, locked, is_custom, section, note | 必填三态：`required`(bool) 与 `required_when`(JSON) 互斥；被引用字段禁停用/删除（422），停用走 `PATCH /order-form-fields/{id}/active`；`locked` 为系统字段不可删 |
| `order_form_section_labels` | order_type_code, section_key, label | 表单板块标题配置驱动，按业务覆盖默认文案 |
| `option_sets` | code, label, group, editable, options(JSON), description | 选项词典；仅 `editable=true` 的组可改；端点 `PUT /option-sets/{code}` |
| `list_column_configs` | scope, column_key, is_visible, sort_order, width, fixed | 列表显示状态，17 张列表共用；自定义列键为 `extra:{field_key}` |
| `list_custom_columns` | scope, column_key, label, source_key, field_type, value_labels | 自定义列定义；恢复默认只清 `list_column_configs`，不删定义；删除走 `DELETE /list-columns/{scope}/custom/{key}` |

### 4.8 运营支撑

| 表 | 关键字段 | 约束 |
|---|---|---|
| `import_batches` | batch_no, source_name, source_kind, status, row_count, unmapped_count, committed_at, rolled_back_at, rolled_back_by, rollback_reason, corrects_batch_id, note | 更正批次经 `corrects_batch_id` 指向被更正批次；回滚保留原因与操作人 |
| `import_rows` | batch_id, row_no, raw(JSON), mapped_order_id, mapped_account_id, mapped_by, mapped_at, mapping_basis, mapped_before, status, unlinked_transfer, issue_note | 未映射行保持 `UNMAPPED` + `issue_note`；单边划转只打 `unlinked_transfer` 标记，不补另一侧 |
| `quality_issues` | issue_no, code, severity, title, entity_type, entity_id, message, details, status, resolution, evidence, closed_by, closed_at | 工单不直接改业务事实；关闭必须留解决方式、关闭人与审计 |
| `notifications` | notification_no, recipient_user_id, notification_type, title, message, entity_type, entity_id, read_at | 按接收人隔离；标记已读不删除 |
| `attachments` | attachment_no, entity_type, entity_id, file_name, storage_key, content_type, size_bytes, sha256, deleted_at | 文件独立存储，删除保留索引行与审计；`sha256` 用于去重校验 |

### 4.9 账号

| 表 | 关键字段 | 约束 |
|---|---|---|
| `users` | username, display_name, password_hash, role, owner_scope, pool_ids(JSON), team_ids(JSON), phone, hired_on, is_active, deactivated_on, handover_user_id, handover_note, must_change_password, note | 密码 PBKDF2-SHA256；离职经 `handover_user_id` 移交而非删除 |
| `teams` | code, name, description, is_active | 团队维度仅用于归属与筛选 |
| `revoked_tokens` | jti, expires_at | JWT 撤销清单，按过期时间清理 |

## 5. 编号规则

序列定义在 `document_sequences`，由 `app/core/numbering.py` 发放，**唯一、不可改、不可复用，不强制无断号**。

| 对象 | 格式 | padding |
|---|---|---|
| 业务订单 | `HS` / `TH` / `DG` + 流水号 | 4 |
| 客户 | `CUS0001` | 4 |
| 合作方 | `CP0001` | 4 |
| 客户需求 | `REQ0001` | 4 |
| 质量工单 | `QI0001` | 4 |
| 通知 | `NTF0001` | 4 |
| 导入批次 | `IMP0001` | 4 |
| 附件 | `ATT0001` | 4 |
| 资金流水·支出 | `ZC00001` | 5 |
| 资金流水·收入 | `SR00001` | 5 |
| 库存 | `KU_00001` | 5 |
| 返点记录 | `HS0001-RB01` | — |


订单编号域随业务动态生成（`ensure_sequence` 按 `order_type_defs.sequence_key/prefix`）；`ORDER_DFQ` 已随代分期下线删除。库存编号在建 BUY 事件（HS/TH）或建单（DG）时发放。返点分次到账编号 `HS0001-RB01-CF-01` 与 `rebate_settlements` 表已于 2026-11-05 下线。

## 6. 活字段边界

**可配置**：标签、渠道等级、账号卖点、预计上架日、客户偏好、客户来源细分、预算、常用平台、跟进备注、合作方备注。

**不可配置**：客户编号、称呼/昵称、微信号、QQ、手机号、订单参与关系、金额、池、收支方向、资金性质、事件/业务类型、正式关联、库存/利润/应收计算字段。

参与核算的活字段必须升格为固定字段。活字段按 `order_form_fields`（定义）+ 各表 `form_extra`（值）落地，八类实体作用域见 §3.5。

客户新建时以微信号、QQ、手机号查询重复候选并返回提示，**不强制拦截**；仅管理员可合并，合并迁移订单参与关系、分期客户关系、需求与引用，来源置 `MERGED` 并保留原编号与完整审计。

## 7. 经营规则配置边界

返点率、手续费、提成率、分期规则、库存跌价规则、多人利润分配和退款分类**可配置**，但必须走 `policy_definitions` / `policy_versions` 与固定快照字段（`policy_version_id` + `policy_snapshot`），**禁止**写入活字段值。

固定不可配置项：DG 代挂沿用统一 `SELL` 事件登记卖出金额与订单利润，寄售方经 `CONSIGNOR` 关联，不配抽成比例或单独结算公式。

多人分配规则：`order_profit_allocations` 的 `allocation_type` 表动作性质（`BUY` / `SELL` / `OPERATION`）或 `COMPANY`（不绑人），`role` 取 `AllocationRole`；分配基数为订单利润（售出金额 − 买入成本 − 直接成本），返点收益独立核算；买号/售出执行人自动绑定不可手改；四项合计必须 100%。

## 8. 口径裁决（长期有效）

1. `game_password` 明文存储为既定裁决，不加密、不脱敏、不进 PII 扫描范围。
2. `total` 语义 = 成交总额（gross），不等于 principal + profit。
3. 资金只到池一级，系统余额为池内已审核流水有符号和，无「开户余额」概念。
4. 历史 89 单可标 `UNLINKED`；19 笔返点保留未关联待人工补齐；不得自动匹配，不阻塞新单上线。
5. 蹭点→DG；氪金联盟提号/氪金提号/提号→TH；小荷包/经营池→`HJ_INVEST`；介绍费、作图费为账号附加 `COST`，不计运营消耗；八月利润转 `UNLINKED_TRANSFER`，无原始凭证不补另一侧。
