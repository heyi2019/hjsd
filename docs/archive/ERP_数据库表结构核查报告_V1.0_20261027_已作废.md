# 黑金时代 ERP v1 数据库表结构核查报告

| 项 | 内容 |
|---|---|
| 文件编号 | `ERP_数据库表结构核查报告_V1.0` |
| 运行域 | 黑金时代 ERP v1（backend 数据库 + API 契约 + 前端消费） |
| 阅读对象 | 何一（发版决策人）、后端开发 |
| 编写日期 | 2026-10-27 |
| 编写人 | WorkBuddy · 数据治理 |
| 核查基线 | `main@f988c6b`（迁移压平为 0001 后）；库 `backend/data/heijin_erp_v1.db` |

**结论摘要**：38 张表全部有意义（0 死表）；37 张业务表字段级死列 0 个；API 已暴露 492 字段中 69 个未在前端按名引用，均可解释（65 审计时间戳 + 4 业务字段写留痕），无死契约；另有 3 个内部字段按设计不进 API（`revoked_tokens.jti`/`expires_at`、`order_type_pools.order_type_id`）。表级 / 字段级 / 契约级三层均无冗余，无需瘦身。

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| V1.0 | 2026-10-27 | 首版：表清单 + 逐表字段 + 字段级活/死判定 + 前端渲染核对（四章） |
| V1.0 | 2026-10-27 | 补第五章前端渲染核对；报告归档至 `docs/`（原 `数据库表结构_20261027.md`） |
| V1.0 | 2026-10-27 | 补第六章结构一致性复核（新装 0001 vs 生产库：真实结构差异 0 表）；记录 `game_type_options` 漂移修复 |

---

> 来源库：`data/heijin_erp_v1.db`（只读导出，3276800 字节）

## 一、结论

- 共 **38 张用户表**（含 1 张 Alembic 迁移系统表 `alembic_version`）。
- **全部 37 张业务表均有意义**：均有 ORM 模型定义、均有实际数据、且至少被一个业务模块（router/service）读写。
- **无死表 / 孤儿表 / 纯冗余表**。
- 4 张表虽无独立 `router/service` 文件名命中（`document_sequences`、`game_type_options`、`order_form_fields`、`order_type_pools`），但分别服务于核心编号生成、基础数据、订单表单配置、类型-池映射，均为活跃配置/底层表，非废弃。
- 行数极少的表（`teams`=1、`period_locks`=1、`game_type_options`=4、`document_sequences`=13）属单例/字典配置，低频正常，非死表。

## 二、总览（业务域 / 角色 / 行数 / 字段数 / 用途）

| 表名 | 业务域 | 角色 | 行数 | 字段数 | 用途 |
|---|---|---|---:|---:|---|
| accounts | 库存/账号 | 核心 | 291 | 21 | 游戏账号库存主表（购入/在售/售出状态） |
| alembic_version | 系统 | 迁移系统表 | 1 | 1 | Alembic 迁移版本控制，非业务数据 |
| attachments | 辅助 | 附件 | 17 | 14 | 业务单据附件（图片/文件） |
| audit_logs | 辅助 | 审计 | 3724 | 10 | 全量操作审计日志 |
| cashflow | 资金 | 核心 | 954 | 25 | 资金流水（按池记账，系统余额来源） |
| counterparties | 客户/对手 | 核心 | 23 | 15 | 交易对手方（对接人/渠道） |
| customer_leads | 客户 | 线索 | 28 | 15 | 客户线索，转化前暂存 |
| customers | 客户 | 核心 | 107 | 19 | 客户主档 |
| deposits | 资金 | 押金 | 25 | 17 | 押金/保证金明细 |
| document_sequences | 基础 | 编号序列 | 13 | 7 | 单号/编号序列生成器（core.numbering 读写） |
| game_type_options | 基础 | 字典 | 4 | 9 | 游戏类型选项字典（foundation 管理） |
| import_batches | 辅助 | 导入 | 17 | 17 | 批量导入任务批次 |
| import_rows | 辅助 | 导入 | 44 | 15 | 导入批次的逐行明细 |
| installment_dispositions | 分期 | 处置明细 | 22 | 11 | 分期处置/冲销记录 |
| installment_schedules | 分期 | 期次 | 438 | 12 | 分期每期计划与回款 |
| installments | 分期 | 核心 | 134 | 26 | 分期主单 |
| notifications | 辅助 | 通知 | 7 | 13 | 站内通知 |
| option_sets | 基础 | 选项集 | 57 | 11 | 可配置选项词典（57 项/12 组） |
| order_counterparty_roles | 订单 | 关联表 | 162 | 6 | 订单-交易对手多对多角色 |
| order_customer_roles | 订单 | 关联表 | 202 | 6 | 订单-客户多对多角色 |
| order_events | 订单 | 核心 | 774 | 21 | 订单事件/状态变更流水 |
| order_form_fields | 订单 | 表单配置 | 255 | 17 | 订单表单字段定义（47 作用域，前端配置口径源） |
| order_links | 订单 | 关联表 | 10 | 12 | 订单间关联（父子/并单） |
| order_profit_allocations | 订单 | 分润明细 | 6 | 10 | 订单利润分配明细 |
| order_type_defs | 基础 | 字典 | 5 | 13 | 订单类型定义 |
| order_type_pools | 基础 | 映射表 | 10 | 9 | 订单类型→资金池映射 |
| orders | 订单 | 核心 | 486 | 27 | 订单主表（成交/成本/分润） |
| period_locks | 基础 | 期锁定 | 1 | 9 | 会计期间锁定（单例配置） |
| policy_definitions | 规则 | 定义 | 9 | 11 | 经营规则定义（闭集预置） |
| policy_versions | 规则 | 版本 | 6 | 14 | 经营规则已发布版本 |
| pools | 基础 | 资金池 | 7 | 11 | 资金池主档（唯一资金一级） |
| quality_issues | 质检 | 核心 | 94 | 18 | 质检/售后问题单 |
| rebate_records | 返点 | 记录 | 37 | 18 | 返点原始记录 |
| rebate_settlements | 返点 | 结算 | 23 | 15 | 返点结算单 |
| reconciliations | 资金 | 对账 | 22 | 17 | 资金对账单 |
| revoked_tokens | 权限 | Token | 3 | 2 | 已吊销 JWT 黑名单 |
| teams | 权限 | 团队 | 1 | 7 | 团队/组织（单例配置） |
| users | 权限 | 用户 | 3 | 18 | 系统用户主档 |

## 三、逐表字段明细

### accounts  （291 行，21 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| game_type | VARCHAR(64) | NOT NULL 默认=0 |
| business_mode | VARCHAR(24) | NOT NULL 默认=0 |
| inventory_type | VARCHAR(24) | NOT NULL 默认=0 |
| game_account | VARCHAR(128) | NOT NULL 默认=0 |
| game_password | VARCHAR(256) | NOT NULL 默认=0 |
| channel_region | VARCHAR(128) | NOT NULL 默认=0 |
| bound_phone | VARCHAR(64) | NOT NULL 默认=0 |
| has_secondary | BOOLEAN | NOT NULL 默认=0 |
| platform | VARCHAR(64) | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| buy_date | DATE | NOT NULL 默认=0 |
| cost_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| account_description | TEXT | NOT NULL 默认=0 |
| account_images | JSON | NOT NULL 默认=0 |
| form_extra | JSON | NOT NULL 默认=0 |

### alembic_version  （1 行，1 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| version_num | VARCHAR(32) | NOT NULL 默认=1 |

### attachments  （17 行，14 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| attachment_no | VARCHAR(32) | NOT NULL 默认=1 |
| entity_type | VARCHAR(32) | NOT NULL 默认=1 |
| entity_id | VARCHAR(128) | NOT NULL 默认=1 |
| file_name | VARCHAR(255) | NOT NULL 默认=1 |
| storage_key | VARCHAR(255) | NOT NULL 默认=1 |
| content_type | VARCHAR(128) | NOT NULL 默认=1 |
| size_bytes | INTEGER | NOT NULL 默认=1 |
| sha256 | VARCHAR(64) | NOT NULL 默认=1 |
| deleted_at | DATETIME | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

### audit_logs  （3724 行，10 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| occurred_at | DATETIME | NOT NULL PK 默认=1 |
| actor | VARCHAR(64) | NOT NULL 默认=1 |
| action | VARCHAR(64) | NOT NULL 默认=1 |
| entity_type | VARCHAR(64) | NOT NULL 默认=1 |
| entity_id | VARCHAR(64) | NOT NULL 默认=1 |
| before_json | JSON | NOT NULL 默认=0 |
| after_json | JSON | NOT NULL 默认=0 |
| reason | TEXT | NOT NULL 默认=0 |
| request_id | VARCHAR(64) | NOT NULL 默认=0 |

### cashflow  （954 行，25 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| flow_no | VARCHAR(32) | NOT NULL 默认=1 |
| pool_id | INTEGER | NOT NULL 默认=1 |
| occurred_on | DATE | NOT NULL 默认=1 |
| nature | VARCHAR(16) | NOT NULL 默认=1 |
| category | VARCHAR(32) | NOT NULL 默认=1 |
| direction | VARCHAR(8) | NOT NULL 默认=1 |
| amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| status | VARCHAR(16) | NOT NULL PK 默认=1 |
| order_id | INTEGER | NOT NULL 默认=0 |
| deposit_id | INTEGER | NOT NULL 默认=0 |
| order_event_id | INTEGER | NOT NULL 默认=0 |
| transfer_id | VARCHAR(64) | NOT NULL 默认=0 |
| reversal_of_id | INTEGER | NOT NULL 默认=0 |
| reviewed_by | VARCHAR(64) | NOT NULL 默认=0 |
| reviewed_at | DATETIME | NOT NULL 默认=0 |
| reversal_reason | TEXT | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| fund_nature | VARCHAR(16) | NOT NULL PK 默认=1 |
| accounting_attribute | VARCHAR(32) | NOT NULL PK 默认=1 |
| form_extra | JSON | NOT NULL 默认=0 |

外键：`order_id`→`orders`.`id`；`pool_id`→`pools`.`id`；`deposit_id`→`deposits`.`id`；`reversal_of_id`→`cashflow`.`id`；`order_event_id`→`order_events`.`id`

### counterparties  （23 行，15 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| counterparty_no | VARCHAR(32) | NOT NULL 默认=1 |
| display_name | VARCHAR(128) | NOT NULL 默认=1 |
| type | VARCHAR(16) | NOT NULL 默认=1 |
| contact_name | VARCHAR(128) | NOT NULL 默认=0 |
| phone | VARCHAR(64) | NOT NULL 默认=0 |
| wechat | VARCHAR(128) | NOT NULL 默认=0 |
| qq | VARCHAR(64) | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| source | VARCHAR(64) | NOT NULL 默认=0 |

### customer_leads  （28 行，15 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| lead_no | VARCHAR(32) | NOT NULL 默认=1 |
| customer_id | INTEGER | NOT NULL 默认=1 |
| request_type | VARCHAR(32) | NOT NULL 默认=1 |
| budget | NUMERIC(18, 2) | NOT NULL 默认=0 |
| target | TEXT | NOT NULL 默认=1 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| owner_id | INTEGER | NOT NULL 默认=0 |
| converted_order_id | INTEGER | NOT NULL 默认=0 |
| closed_reason | TEXT | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

外键：`converted_order_id`→`orders`.`id`；`owner_id`→`users`.`id`；`customer_id`→`customers`.`id`

### customers  （107 行，19 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| customer_no | VARCHAR(32) | NOT NULL 默认=1 |
| display_name | VARCHAR(128) | NOT NULL 默认=1 |
| contact_name | VARCHAR(128) | NOT NULL 默认=0 |
| phone | VARCHAR(64) | NOT NULL 默认=0 |
| wechat | VARCHAR(128) | NOT NULL 默认=0 |
| qq | VARCHAR(64) | NOT NULL 默认=0 |
| source | VARCHAR(64) | NOT NULL 默认=0 |
| owner_id | INTEGER | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| tags | JSON | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| merged_into_id | INTEGER | NOT NULL 默认=0 |
| merged_reason | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| form_extra | JSON | NOT NULL 默认=0 |

外键：`owner_id`→`users`.`id`；`merged_into_id`→`customers`.`id`

### deposits  （25 行，17 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| pool_id | INTEGER | NOT NULL 默认=1 |
| counterparty_id | INTEGER | NOT NULL 默认=0 |
| source_order_id | INTEGER | NOT NULL 默认=0 |
| paid_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| returned_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| lost_amount | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| status | VARCHAR(24) | NOT NULL 默认=1 |
| paid_on | DATE | NOT NULL 默认=1 |
| expected_release_on | DATE | NOT NULL 默认=0 |
| released_on | DATE | NOT NULL 默认=0 |
| lost_on | DATE | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`source_order_id`→`orders`.`id`；`pool_id`→`pools`.`id`；`counterparty_id`→`counterparties`.`id`

### document_sequences  （13 行，7 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| sequence_key | VARCHAR(64) | NOT NULL 默认=1 |
| prefix | VARCHAR(16) | NOT NULL 默认=1 |
| padding | INTEGER | NOT NULL 默认=1 |
| current_value | INTEGER | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

### game_type_options  （4 行，9 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| name | VARCHAR(64) | NOT NULL 默认=1 |
| sort_order | INTEGER | NOT NULL 默认=1 |
| is_active | BOOLEAN | NOT NULL 默认=1 |
| is_default | BOOLEAN | NOT NULL 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

### import_batches  （17 行，17 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| batch_no | VARCHAR(32) | NOT NULL 默认=1 |
| source_name | VARCHAR(128) | NOT NULL 默认=1 |
| source_kind | VARCHAR(32) | NOT NULL PK 默认=1 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| row_count | INTEGER | NOT NULL 默认=1 |
| unmapped_count | INTEGER | NOT NULL 默认=1 |
| committed_at | DATETIME | NOT NULL 默认=0 |
| rolled_back_at | DATETIME | NOT NULL 默认=0 |
| rolled_back_by | VARCHAR(64) | NOT NULL 默认=0 |
| rollback_reason | TEXT | NOT NULL 默认=0 |
| corrects_batch_id | INTEGER | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`corrects_batch_id`→`import_batches`.`id`

### import_rows  （44 行，15 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| batch_id | INTEGER | NOT NULL 默认=1 |
| row_no | INTEGER | NOT NULL 默认=1 |
| raw | JSON | NOT NULL 默认=1 |
| mapped_order_id | INTEGER | NOT NULL 默认=0 |
| mapped_account_id | INTEGER | NOT NULL 默认=0 |
| mapped_by | VARCHAR(64) | NOT NULL 默认=0 |
| mapped_at | DATETIME | NOT NULL 默认=0 |
| mapping_basis | TEXT | NOT NULL 默认=0 |
| mapped_before | JSON | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| unlinked_transfer | BOOLEAN | NOT NULL 默认=1 |
| issue_note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`mapped_account_id`→`accounts`.`id`；`batch_id`→`import_batches`.`id`；`mapped_order_id`→`orders`.`id`

### installment_dispositions  （22 行，11 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| installment_id | INTEGER | NOT NULL 默认=1 |
| account_id | INTEGER | NOT NULL 默认=1 |
| action | VARCHAR(16) | NOT NULL 默认=1 |
| occurred_on | DATE | NOT NULL 默认=1 |
| related_order_id | INTEGER | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

外键：`account_id`→`accounts`.`id`；`installment_id`→`installments`.`id`；`related_order_id`→`orders`.`id`

### installment_schedules  （438 行，12 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| installment_id | INTEGER | NOT NULL 默认=1 |
| period_no | INTEGER | NOT NULL 默认=1 |
| due_on | DATE | NOT NULL 默认=1 |
| due_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| received_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| received_on | DATE | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| waived_amount | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| service_fee_rate | NUMERIC(18, 2) | NOT NULL PK 默认=1 |

外键：`installment_id`→`installments`.`id`

### installments  （134 行，26 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| inst_no | VARCHAR(32) | NOT NULL 默认=1 |
| order_id | INTEGER | NOT NULL 默认=1 |
| contract_type | VARCHAR(24) | NOT NULL 默认=1 |
| policy_version_id | INTEGER | NOT NULL 默认=0 |
| policy_snapshot | JSON | NOT NULL 默认=0 |
| principal | NUMERIC(18, 2) | NOT NULL 默认=1 |
| down_payment | NUMERIC(18, 2) | NOT NULL 默认=1 |
| periods | INTEGER | NOT NULL 默认=1 |
| per_period | NUMERIC(18, 2) | NOT NULL 默认=1 |
| paid_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| delivery_mode | VARCHAR(24) | NOT NULL 默认=0 |
| delivered_on | DATE | NOT NULL 默认=0 |
| first_due_on | DATE | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| service_fee | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| per_period_service_fee | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| waived_amount | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| bad_debt_amount | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| final_period_adjustment | NUMERIC(18, 2) | NOT NULL PK 默认=1 |
| form_extra | JSON | NOT NULL 默认=0 |

外键：`policy_version_id`→`policy_versions`.`id`；`order_id`→`orders`.`id`

### notifications  （7 行，13 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| notification_no | VARCHAR(32) | NOT NULL 默认=1 |
| recipient_user_id | INTEGER | NOT NULL 默认=1 |
| notification_type | VARCHAR(64) | NOT NULL 默认=1 |
| title | VARCHAR(256) | NOT NULL 默认=1 |
| message | TEXT | NOT NULL 默认=1 |
| entity_type | VARCHAR(64) | NOT NULL 默认=1 |
| entity_id | VARCHAR(128) | NOT NULL 默认=1 |
| read_at | DATETIME | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

外键：`recipient_user_id`→`users`.`id`

### option_sets  （57 行，11 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| code | VARCHAR(64) | NOT NULL 默认=1 |
| label | VARCHAR(128) | NOT NULL 默认=1 |
| group | VARCHAR(64) | NOT NULL PK 默认=1 |
| editable | BOOLEAN | NOT NULL PK 默认=1 |
| options | JSON | NOT NULL 默认=0 |
| description | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL PK 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL PK 默认=1 |

### order_counterparty_roles  （162 行，6 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| order_id | INTEGER | NOT NULL 默认=1 |
| counterparty_id | INTEGER | NOT NULL 默认=1 |
| role | VARCHAR(32) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`order_id`→`orders`.`id`；`counterparty_id`→`counterparties`.`id`

### order_customer_roles  （202 行，6 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| order_id | INTEGER | NOT NULL 默认=1 |
| customer_id | INTEGER | NOT NULL 默认=1 |
| role | VARCHAR(32) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`order_id`→`orders`.`id`；`customer_id`→`customers`.`id`

### order_events  （774 行，21 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| event_no | VARCHAR(32) | NOT NULL 默认=1 |
| order_id | INTEGER | NOT NULL 默认=1 |
| event_type | VARCHAR(16) | NOT NULL 默认=1 |
| amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| portion | VARCHAR(16) | NOT NULL 默认=1 |
| occurred_on | DATE | NOT NULL 默认=1 |
| pool_id | INTEGER | NOT NULL 默认=0 |
| offset_event_id | INTEGER | NOT NULL 默认=0 |
| delivery_mode | VARCHAR(24) | NOT NULL 默认=0 |
| is_posted | BOOLEAN | NOT NULL 默认=1 |
| posted_at | DATETIME | NOT NULL 默认=0 |
| reason | TEXT | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| refund_responsibility | VARCHAR(32) | NOT NULL 默认=0 |
| operator_user_ids | JSON | NOT NULL 默认=0 |
| form_extra | JSON | NOT NULL 默认=0 |

外键：`offset_event_id`→`order_events`.`id`；`order_id`→`orders`.`id`；`pool_id`→`pools`.`id`

### order_form_fields  （255 行，17 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| order_type_code | VARCHAR(16) | NOT NULL 默认=1 |
| field_key | VARCHAR(64) | NOT NULL 默认=1 |
| label | VARCHAR(128) | NOT NULL 默认=1 |
| field_type | VARCHAR(16) | NOT NULL PK 默认=1 |
| options | JSON | NOT NULL 默认=0 |
| required | BOOLEAN | NOT NULL PK 默认=1 |
| is_active | BOOLEAN | NOT NULL PK 默认=1 |
| sort_order | INTEGER | NOT NULL PK 默认=1 |
| locked | BOOLEAN | NOT NULL PK 默认=1 |
| is_custom | BOOLEAN | NOT NULL PK 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL PK 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL PK 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| required_when | JSON | NOT NULL 默认=0 |

### order_links  （10 行，12 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| source_order_id | INTEGER | NOT NULL 默认=1 |
| target_order_id | INTEGER | NOT NULL 默认=1 |
| relation_type | VARCHAR(16) | NOT NULL 默认=1 |
| split_ratio | NUMERIC(18, 2) | NOT NULL 默认=0 |
| split_amount | NUMERIC(18, 2) | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| form_extra | JSON | NOT NULL 默认=0 |

外键：`target_order_id`→`orders`.`id`；`source_order_id`→`orders`.`id`

### order_profit_allocations  （6 行，10 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| order_id | INTEGER | NOT NULL 默认=1 |
| user_id | INTEGER | NOT NULL 默认=0 |
| role | VARCHAR(32) | NOT NULL 默认=1 |
| allocation_rate | NUMERIC(18, 2) | NOT NULL 默认=1 |
| policy_version_id | INTEGER | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| allocation_type | VARCHAR(16) | NOT NULL 默认=0 |
| allocation_amount | NUMERIC(18, 2) | NOT NULL PK 默认=1 |

外键：`order_id`→`orders`.`id`；`user_id`→`users`.`id`；`policy_version_id`→`policy_versions`.`id`

### order_type_defs  （5 行，13 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| code | VARCHAR(16) | NOT NULL 默认=1 |
| name | VARCHAR(64) | NOT NULL 默认=1 |
| capital_type | VARCHAR(16) | NOT NULL 默认=1 |
| sequence_prefix | VARCHAR(16) | NOT NULL 默认=1 |
| sequence_key | VARCHAR(64) | NOT NULL 默认=1 |
| is_active | BOOLEAN | NOT NULL 默认=1 |
| sort_order | INTEGER | NOT NULL 默认=1 |
| description | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

### order_type_pools  （10 行，9 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| order_type_id | INTEGER | NOT NULL 默认=1 |
| pool_id | INTEGER | NOT NULL 默认=1 |
| portion | VARCHAR(16) | NOT NULL 默认=1 |
| priority | INTEGER | NOT NULL 默认=1 |
| is_active | BOOLEAN | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| fund_nature | VARCHAR(16) | NOT NULL 默认=0 |

外键：`pool_id`→`pools`.`id`；`order_type_id`→`order_type_defs`.`id`

### orders  （486 行，27 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| order_no | VARCHAR(32) | NOT NULL 默认=1 |
| order_type | VARCHAR(16) | NOT NULL 默认=1 |
| capital_type | VARCHAR(16) | NOT NULL 默认=1 |
| trade_date | DATE | NOT NULL 默认=1 |
| account_id | INTEGER | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| policy_version_id | INTEGER | NOT NULL 默认=0 |
| policy_snapshot | JSON | NOT NULL 默认=0 |
| link_status | VARCHAR(24) | NOT NULL 默认=1 |
| owner_id | INTEGER | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| commission_mode | VARCHAR(32) | NOT NULL 默认=0 |
| commission_payer | VARCHAR(16) | NOT NULL 默认=0 |
| account_snapshot | JSON | NOT NULL 默认=0 |
| game_type | VARCHAR(64) | NOT NULL 默认=0 |
| game_account | VARCHAR(128) | NOT NULL 默认=0 |
| game_password | VARCHAR(256) | NOT NULL 默认=0 |
| channel_region | VARCHAR(128) | NOT NULL 默认=0 |
| bound_phone | VARCHAR(64) | NOT NULL 默认=0 |
| has_secondary | BOOLEAN | NOT NULL 默认=0 |
| account_note | TEXT | NOT NULL 默认=0 |
| form_extra | JSON | NOT NULL 默认=0 |

外键：`policy_version_id`→`policy_versions`.`id`；`owner_id`→`users`.`id`；`account_id`→`accounts`.`id`

### period_locks  （1 行，9 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| period | VARCHAR(7) | NOT NULL 默认=1 |
| locked_at | DATETIME | NOT NULL PK 默认=1 |
| locked_by | VARCHAR(64) | NOT NULL 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

### policy_definitions  （9 行，11 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| policy_code | VARCHAR(32) | NOT NULL 默认=1 |
| name | VARCHAR(128) | NOT NULL 默认=1 |
| scope_type | VARCHAR(32) | NOT NULL PK 默认=1 |
| scope_id | INTEGER | NOT NULL 默认=0 |
| description | TEXT | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL PK 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL PK 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL PK 默认=1 |

### policy_versions  （6 行，14 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| policy_definition_id | INTEGER | NOT NULL 默认=1 |
| version | INTEGER | NOT NULL 默认=1 |
| effective_from | DATE | NOT NULL 默认=1 |
| effective_to | DATE | NOT NULL 默认=0 |
| config | JSON | NOT NULL 默认=1 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| approved_by | VARCHAR(64) | NOT NULL 默认=0 |
| approved_at | DATETIME | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`policy_definition_id`→`policy_definitions`.`id`

### pools  （7 行，11 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| code | VARCHAR(64) | NOT NULL 默认=1 |
| name | VARCHAR(128) | NOT NULL 默认=1 |
| pool_type | VARCHAR(32) | NOT NULL 默认=1 |
| ownership | VARCHAR(16) | NOT NULL 默认=1 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

### quality_issues  （94 行，18 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| issue_no | VARCHAR(32) | NOT NULL 默认=1 |
| code | VARCHAR(64) | NOT NULL 默认=1 |
| severity | VARCHAR(16) | NOT NULL 默认=1 |
| title | VARCHAR(256) | NOT NULL 默认=1 |
| entity_type | VARCHAR(64) | NOT NULL 默认=1 |
| entity_id | VARCHAR(128) | NOT NULL 默认=1 |
| message | TEXT | NOT NULL 默认=1 |
| details | JSON | NOT NULL 默认=0 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| resolution | TEXT | NOT NULL 默认=0 |
| evidence | TEXT | NOT NULL 默认=0 |
| closed_by | VARCHAR(64) | NOT NULL 默认=0 |
| closed_at | DATETIME | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |

### rebate_records  （37 行，18 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| rebate_no | VARCHAR(32) | NOT NULL 默认=1 |
| source_order_id | INTEGER | NOT NULL 默认=1 |
| channel | VARCHAR(64) | NOT NULL 默认=0 |
| rate | NUMERIC(18, 2) | NOT NULL 默认=1 |
| base_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| policy_version_id | INTEGER | NOT NULL 默认=0 |
| policy_snapshot | JSON | NOT NULL 默认=0 |
| link_status | VARCHAR(24) | NOT NULL 默认=1 |
| status | VARCHAR(24) | NOT NULL 默认=1 |
| collected_on | DATE | NOT NULL 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| rebate_type | VARCHAR(16) | NOT NULL 默认=1 |
| expected_on | DATE | NOT NULL 默认=0 |

外键：`source_order_id`→`orders`.`id`；`policy_version_id`→`policy_versions`.`id`

### rebate_settlements  （23 行，15 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| settlement_no | VARCHAR(48) | NOT NULL 默认=1 |
| rebate_record_id | INTEGER | NOT NULL 默认=1 |
| settled_on | DATE | NOT NULL 默认=1 |
| gross_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| platform_fee | NUMERIC(18, 2) | NOT NULL 默认=1 |
| net_amount | NUMERIC(18, 2) | NOT NULL 默认=1 |
| cashflow_id | INTEGER | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| reversal_of_id | INTEGER | NOT NULL 默认=0 |
| fee_cashflow_id | INTEGER | NOT NULL 默认=0 |

外键：`fee_cashflow_id`→`cashflow`.`id`；`cashflow_id`→`cashflow`.`id`；`rebate_record_id`→`rebate_records`.`id`；`reversal_of_id`→`rebate_settlements`.`id`

### reconciliations  （22 行，17 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| pool_id | INTEGER | NOT NULL 默认=1 |
| reconciled_on | DATE | NOT NULL 默认=1 |
| account_label | VARCHAR(128) | NOT NULL 默认=1 |
| system_balance | NUMERIC(18, 2) | NOT NULL 默认=1 |
| statement_balance | NUMERIC(18, 2) | NOT NULL 默认=1 |
| difference | NUMERIC(18, 2) | NOT NULL 默认=1 |
| status | VARCHAR(16) | NOT NULL 默认=1 |
| reason | TEXT | NOT NULL 默认=0 |
| unmatched_flow_ids | JSON | NOT NULL 默认=1 |
| resolved_by | VARCHAR(64) | NOT NULL 默认=0 |
| resolved_at | DATETIME | NOT NULL 默认=0 |
| note | TEXT | NOT NULL 默认=0 |
| created_by | VARCHAR(64) | NOT NULL 默认=1 |
| updated_by | VARCHAR(64) | NOT NULL 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

外键：`pool_id`→`pools`.`id`

### revoked_tokens  （3 行，2 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| jti | VARCHAR(64) | NOT NULL 默认=1 |
| expires_at | INTEGER | NOT NULL 默认=1 |

### teams  （1 行，7 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| code | VARCHAR(64) | NOT NULL 默认=1 |
| name | VARCHAR(128) | NOT NULL 默认=1 |
| description | TEXT | NOT NULL 默认=0 |
| is_active | BOOLEAN | NOT NULL PK 默认=1 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |

### users  （3 行，18 字段）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | INTEGER | NOT NULL 默认=1 |
| username | VARCHAR(64) | NOT NULL 默认=1 |
| display_name | VARCHAR(128) | NOT NULL 默认=1 |
| password_hash | VARCHAR(256) | NOT NULL 默认=1 |
| role | VARCHAR(32) | NOT NULL PK 默认=1 |
| owner_scope | VARCHAR(16) | NOT NULL PK 默认=1 |
| pool_ids | JSON | NOT NULL PK 默认=1 |
| team_ids | JSON | NOT NULL PK 默认=1 |
| phone | VARCHAR(32) | NOT NULL 默认=0 |
| is_active | BOOLEAN | NOT NULL PK 默认=1 |
| must_change_password | BOOLEAN | NOT NULL PK 默认=1 |
| note | TEXT | NOT NULL 默认=0 |
| created_at | DATETIME | NOT NULL PK 默认=1 |
| updated_at | DATETIME | NOT NULL PK 默认=1 |
| deactivated_on | DATE | NOT NULL 默认=0 |
| handover_user_id | INTEGER | NOT NULL 默认=0 |
| handover_note | TEXT | NOT NULL 默认=0 |
| hired_on | DATE | NOT NULL 默认=0 |

外键：`handover_user_id`→`users`.`id`

---

## 四、字段级活/死判定（2026-10-27 补充）

> 在"表是否有意义"结论基础上，进一步对**每个字段**做引用穿透，回答"字段是否都可被消费"。

### 4.1 方法论
- 死字段判定口径：**字段在 `app/` 中除 `domain/`（ORM 定义）与 `migration/`（DDL 历史）之外的任何位置都未出现，且前端 `frontend/src` 也未引用（snake / camel 双向匹配）** → 候选死列。
- 暴露度口径：字段名是否出现在任一 Pydantic 响应 schema 文件（`*schema*.py`）→ 决定"前端能否经 API 消费"。

### 4.2 结论
- **37 张业务表字段级死列候选 = 0**。每个字段至少在后端业务代码（service/router/专项模块如 `finance/rebates.py`、`finance/cashflows.py`）或前端被引用，无纯冗余字段。
- 全库唯一"未在任何业务代码引用"的列是 `alembic_version.version_num`——**Alembic 迁移系统列，非业务字段，不计死列**。
- 优先复核的两类表（单例/字典表 + 关联桥接表，共 16 张）字段暴露度：除 3 个"故意不暴露"的内部字段外，**全部进入 API 响应 schema，前端可消费**：
  - `revoked_tokens.jti` / `revoked_tokens.expires_at`：JWT 黑名单，仅认证中间件内部读，不进 API（设计如此）。
  - `order_type_pools.order_type_id`：关联 `order_type_defs` 的内部外键，schema 改用 `order_type_code` 暴露（设计如此）。
- 行数极少的单例/字典表（`teams`=1、`period_locks`=1、`game_type_options`=4、`document_sequences`=13）**字段数量合理，无过度设计**——以 `teams`(7 字段) / `period_locks`(9 字段) 为例，字段均为配置/审计必需，无冗余。

### 4.3 最终判定
**数据库在表级与字段级均无冗余：38 张表全部有意义，数百个字段全部被消费，无任何死表 / 死列 / 纯冗余结构。** 模型设计整洁，无需"瘦身"。

---

## 五、前端渲染核对（API↔前端契约，2026-10-27 补充）

> 上一章确认"字段后端已暴露（进 schema）"。本章进一步核对：已暴露字段前端是否真的消费（渲染/读取），区分"死字段"与"已暴露但未在 UI 呈现"。

### 5.1 方法
- 已暴露字段：按表归属模块定位响应 schema（`*schema*.py`），精确判定字段是否进 API 响应。
- 前端消费：在 `frontend/src` 全量 grep 字段的 snake / camel 双向命名（`\b` 词边界）。

### 5.2 结果
- **已暴露字段总数：492**；**已暴露但前端无按名引用：69**。
- 69 个候选全部可解释，无一为死字段：
  - **65 个为审计时间戳**（`updated_at` / `updated_by`）：整个 `frontend/src` 中 `updatedAt`/`updatedBy` 出现 **0 次**——前端设计上不渲染"更新时间/更新人"，属一致性设计选择，非冗余。这类列用于数据血缘与审计留痕，保留正确。
  - **4 个业务字段**（后端写入落库，列表视图未展示，非死列）：
    | 字段 | 后端用途 | 前端现状 |
    |---|---|---|
    | `customer_leads.converted_order_id` | 转单时记录目标订单 | `CustomerLeadPanel` 列表未展示（仅写） |
    | `customer_leads.closed_reason` | 关闭需求时记录原因 | 同上，未展示 |
    | `notifications.recipient_user_id` | 通知收件人（隐式=当前用户） | `NotificationsPanel` 用 `entity_type:entity_id` 表示对象，未单列收件人 |
    | `notifications.notification_type` | 通知分类 | 列表未展示分类 |

### 5.3 最终判定
- **数据库→API→前端 全链路无死字段、无死契约。**
- 唯一"已暴露但未在 UI 呈现"的是审计时间戳（设计选择）与 4 个业务字段（写留痕、列表未显）。这些**不构成数据冗余或待清理项**；若要做 UX 增强，可在对应详情/列表视图补展示（属前端小事，非库问题）。
- 本轮数据库优化与表/字段/契约三层审计全部收口，确认：38 表有意义、数百字段全被消费、API 契约无废弃字段。

---

## 六、结构一致性复核（新装 0001 vs 生产库，2026-10-27 补充）

> 迁移压平为单一 `0001` 后，用"全新空库 upgrade head"产物与生产库做全维度对拍，确认发布基线与存量库结构同源。

### 6.1 对拍结果
- 表清单：37 张业务表**完全一致**。
- 列集合 / 列类型 / 列约束 / 索引 / 外键：**真实结构差异 0 表**。
- 行数差：0（结构对拍不比对业务数据）。
- 仅 **23 张表列顺序不同**——历史 `ALTER TABLE ADD COLUMN` 追加列所致，字段集合与定义完全一致，语义等价。
- DDL 文本 33 张不同，但差异仅为 `DEFAULT (CURRENT_TIMESTAMP)` 的括号写法，非语义差异。

### 6.2 已修复的一处真实漂移
- **`game_type_options`**：生产库建于早期迁移链，缺 3 个 DB 级默认值（`sort_order DEFAULT '0'`、`is_active DEFAULT 1`、`is_default DEFAULT 0`）；0001 基线含默认值。
- **处置**：以基线 DDL 逐字重建该表（4 行，无子表外键引用、无 trigger/view），单事务内 `RENAME → CREATE → INSERT SELECT → DROP`，关闭外键检查执行。
- **验证**：重建后 DDL 与基线逐字相同、4 行数据全等、`integrity_check=ok`、`foreign_key_check` 无违规、`uq_game_type_options_name` 自动索引保留、`alembic check` 零漂移；探针 INSERT（仅给 `name`+审计列）读回 `sort_order=0 / is_active=1 / is_default=0`，已回滚无残留。
- **未新增迁移**：0001 本身已产出正确 DDL，该漂移只存在于本地存量库；新装路径无需修正。备份 `backend/data/backups/heijin_erp_v1_before_gt_fix_20261027_184546.db`。

### 6.3 结论
**发布基线（0001）与生产库结构同源、真实差异为零**，可作为发版基线；剩余列顺序差异属 SQLite 历史遗留，不影响 ORM 映射、不影响 SQL 正确性，无需重建。
