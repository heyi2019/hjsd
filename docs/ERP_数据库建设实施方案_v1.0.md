# 宜游轩 ERP · 数据库建设实施方案 v1.0

> 版本：v1.0 ｜ **依据**：[PRD v1.2](ERP_PRD_v1.2_当前实现版.md) → [ERP_PRD_F01_功能规格说明书](ERP_PRD_F01_功能规格说明书.md) → [DDL 与迁移方案](ERP_数据库DDL与迁移方案_v1.0.md) / [数据字典](ERP_数据字典_v1.0.md)。数据导入仅为 P2。

## 1. 建设目标与现状

目标是在不篡改导入原始数据的前提下，建立可审计的订单事件、资金池、库存、分期、返点和活字段数据库。

当前已有 SQLite 过渡基础库、`models_new`、`services_new` 与数据导入脚本；但分期 PAYMENT、返点分次结算、押金、完整活字段、正式外键/索引和 Alembic 迁移尚未完整落地。

## 2. 数据库策略

| 场景 | 方案 |
|---|---|
| 本地开发/MVP | SQLite，开启外键，独立 v1 数据库文件 |
| 正式环境 | PostgreSQL，使用 Alembic 管理迁移 |
| 金额 | `DECIMAL(18,2)` + Python `Decimal`，禁止 float |
| 迁移 | 旧库/原始 JSON 只读；迁移只写新库；每次前备份 |
| 删除 | 有流水的池、历史活字段、核心凭证禁止物理删除，改停用/作废 |

## 3. 建设顺序（M0）

1. 初始化迁移框架、环境配置、SQLite 外键和基础审计字段。
2. 建 `pools`、`order_type_defs`、`order_type_pools`、`customers`、`counterparties` 等主数据；客户与合作方分别按 `CUS`、`CP` 编号。
3. 建 `accounts`、`orders`、`order_customer_roles`、`order_counterparty_roles`、`order_events`、`cashflow`，实现订单客户/合作方多角色关联与事件→现金流一对一。
4. 建 `installments` 与 `installment_schedules`：以 `contract_type` 区分 HS 的 STOCK_SALE 与 DFQ 的 ADVANCE_PURCHASE；一单一合约，期次计划支持 PAYMENT、逾期、换绑、断分期处置，结清交付以无现金流 DELIVER 记录。
5. 建 `rebate_records`、`rebate_settlements`，支持 `HS0001-RB01` 与分次到账。
6. 建 `deposits`，关联押金缴纳、退回的现金流。
7. 建 `field_definitions`、`entity_extra_values`，实现非核算活字段。
8. 建报表所需索引与新业务质量校验。

## 4. 核心表与不可变规则

| 领域 | 表 | 不可变规则 |
|---|---|---|
| 资金池 | pools / cashflow | 每笔现金流必有 pool；池 code 不改；有流水不删 |
| 订单 | orders / order_events | 订单号、事件号不改不复用；有资金事件派生唯一 cashflow |
| 账号 | accounts | `inventory_no` 是 ACC 库存编号；`game_account` 只是游戏账号文本；HS 买入必须关联库存账号，DFQ 买入只保留订单账号快照，不关联库存账号；手机号不作关联键 |
| 客户 | customers / order_customer_roles | 微信号、QQ、手机号、备注为客户资料；联系方式非唯一；新建返回重复候选，管理员合并后来源置 `MERGED`；停用/合并后不可新关联，历史关系保留 |
| 合作方 | counterparties / order_counterparty_roles | 同行、供货方、平台与客户分离；仅允许匹配的业务角色参与订单；停用后不可新关联 |
| 分期 | installments / installment_schedules | `ADVANCE_PURCHASE` 仅 DFQ，`STOCK_SALE` 仅已买入 HS；一单一合约；期次计划与总应收、已收、剩余应收勾稽 |
| 返点 | rebate_records / rebate_settlements | 新归集必须来源订单；结算毛额−手续费=净额 |
| 押金 | deposits | 可退押金不进经营损益；缴退均关联现金流 |
| 活字段 | field_definitions / entity_extra_values | 不得覆盖固定核算字段；有历史值只能停用 |

## 5. 数据导入与异常处理（P2）

- 89 笔主业务订单：迁入但标 `UNLINKED`，不自动关联账号。
- 返点必须关联有效来源订单；来源无法确认的记录不得作为返点入账。
- 无可靠订单/账号的分期：标 `ORPHAN`。
- 八月利润转入：标 `UNLINKED_TRANSFER`，无原始凭证不得补造双边 INTERNAL。
- 介绍费、作图费：标待关联 `COST`，不计运营消耗。

每次人工补链必须记录：原始记录、补链依据、操作者、时间、变更前后值。

## 6. 迁移、回滚与发布

1. 发布前备份数据库、导出 schema 版本和迁移前核算快照。
2. 运行 Alembic upgrade；禁止人工在生产库直接 DDL。
3. 运行迁移后对账、外键检查、索引检查和 API smoke test。
4. 若失败，停止写入，恢复备份或执行对应 downgrade；不得用手工改余额修复。
5. 发布成功后保存迁移报告、版本号、五项核算结果和异常数量。

## 7. M0 验收清单（新业务 P0）

- [ ] 所有表、外键、唯一索引、检查约束由迁移脚本创建。
- [ ] 新增 HS/TH/DG/DFQ、资金池、路由无需改 Schema。
- [ ] 事件、现金流、订单、账号、分期、返点、押金、客户/合作方参与关系、活字段写入均有事务测试。
- [ ] 新 INTERNAL 逐对相等；可退押金不进入损益；TH 的 PICKUP 实体可追踪但不计入自营库存资产。

## 8. P2 历史参考验收

- [ ] 历史 `UNLINKED` / `ORPHAN` / `UNLINKED_TRANSFER` 在异常工作台可见。
- [ ] 现金头寸 45,331.53、经营损益 -8,839.69、权益 -54,668.47 仅用于迁移结果对照。
- [ ] 全部金额字段精度两位；无 float；迁移可重复执行。
