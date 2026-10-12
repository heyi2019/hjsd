# 宜游轩 ERP · 数据库 DDL 与迁移方案 v1.0

> **依据**：PRD v1.0 → 功能规格说明书 v1.0 → 数据字典 v1.0。MVP 使用 SQLite，生产迁 PostgreSQL 时由 Alembic 承接同结构；历史迁移仅为 P2 参考能力。

## 1. 建表顺序

`pools` → `order_type_defs` → `order_type_pools` → `policy_definitions` → `policy_versions` → `customers` / `counterparties` → `accounts` → `orders` → `order_customer_roles` / `order_counterparty_roles` → `order_profit_allocations` → `order_events` → `cashflow` → `installments` → `installment_schedules` → `rebate_records` → `rebate_settlements` → `deposits` → `field_definitions` → `entity_extra_values`。

## 2. DDL 约束清单

| 表 | 主键/唯一键 | 外键及检查 |
|---|---|---|
| pools | `id`, `code UNIQUE` | ownership: OWNED/CUSTODY/THIRD_PART；有流水禁止删除 |
| order_type_defs | `id`, `code UNIQUE` | capital_type 为已登记类型 |
| order_type_pools | `UNIQUE(order_type_id, portion)` | FK 业务、池 |
| accounts | `id`, `account_no UNIQUE`, `game_account UNIQUE NULL` | channels JSON；手机号非唯一 |
| customers | `id`, `customer_no UNIQUE` | 联系方式非唯一；停用客户不得作为新订单参与方 |
| order_customer_roles | `id`, `UNIQUE(order_id, customer_id, role)` | FK order/customer；角色为 SELLER/BUYER/CONSIGNOR/INSTALLMENT_CUSTOMER |
| counterparties | `id`, `counterparty_no UNIQUE` | type 为 PEER/SUPPLIER/PLATFORM；停用合作方不得作为新订单参与方 |
| order_counterparty_roles | `id`, `UNIQUE(order_id, counterparty_id, role)` | FK order/counterparty；角色为 PEER/SUPPLIER/PLATFORM |
| orders | `id`, `order_no UNIQUE` | FK account nullable；order_type 必须存在主数据 |
| order_events | `id`, `event_no UNIQUE` | FK order/pool/offset_event；金额>0 |
| cashflow | `id`, `flow_no UNIQUE`, `order_event_id UNIQUE NULL` | pool 必填；新 INTERNAL 需 transfer_id |
| installments | `id`, `inst_no UNIQUE`, `order_id UNIQUE` | `contract_type` 为 STOCK_SALE/ADVANCE_PURCHASE；`delivery_mode` 为 PLATFORM_OPERATOR/CUSTOMER_SELF；前者仅已买入 HS，后者仅 DFQ；总应收勾稽 |
| installment_schedules | `id`, `UNIQUE(installment_id, period_no)` | FK installments；期次应收/实收/到期日/状态；支持部分收款与逾期 |
| rebate_records | `id`, `rebate_group_no UNIQUE` | 新数据 source_order 必填 |
| rebate_settlements | `id`, `settlement_no UNIQUE`, `cashflow_id UNIQUE` | gross - fee = net |
| deposits | `id`, `deposit_no UNIQUE` | paid/returned 金额、关联流水 |
| policy_definitions | `id`, `policy_code UNIQUE` | 定义规则类型与可用范围；不直接保存业务快照 |
| policy_versions | `id`, `UNIQUE(policy_definition_id, version, effective_from)` | 生效区间、配置 JSON、状态、审批审计；已被引用不可更新/删除 |
| order_profit_allocations | `id`, `UNIQUE(order_id, user_id, role)` | FK order/user/policy_version；同订单有效分配比例合计 100% |
| field_definitions | `UNIQUE(entity_type, field_key)` | 有历史值只能停用 |
| entity_extra_values | `UNIQUE(entity_type, entity_id, field_definition_id)` | value JSON |

## 3. 必需索引

- `cashflow(pool_id, occurred_on)`、`cashflow(nature)`、`cashflow(transfer_id)`；
- `orders(order_type, trade_date)`、`orders(link_status)`；
- `customers(phone)`、`customers(wechat)`、`customers(qq)`、`counterparties(type,status)`；
- `order_events(order_id, event_type, occurred_on)`；
- `accounts(status)`、`rebate_records(source_order_id)`、`installments(status,next_pay_date)`、`installment_schedules(installment_id,due_on,status)`。

## 4. 历史参考迁移流程（P2）

1. 备份旧 `heijin.db` 和原始 JSON；历史迁移只写新 ERP 的参考记录区，不覆盖新业务数据。
2. 写种子池 `HJ_INVEST`、`HJ_PROFIT`，写 HS/TH/DG/DFQ 和默认路由。
3. 迁移账户、主业务订单、历史返点、分期、需求、现金流；每阶段输出行数与异常数。
4. 历史订单/返点/分期无可靠关联时分别标 UNLINKED/ORPHAN；不得自动匹配。
5. “八月利润转入”写 `UNLINKED_TRANSFER`；不得补造源池流水。
6. 执行核算对账和质量检查；失败仅输出审计报告，不覆盖原始记录。

## 5. 数据升级规则

- SQLite 仅允许追加列、表、索引；结构重构通过新 schema revision 迁移，禁止直接破坏旧表。
- 每个 schema 变更有 Alembic revision、回滚说明和迁移前备份。
- `pool.code`、业务 code、业务编号、正式关联不可更新；名称、备注、活字段可更新。
