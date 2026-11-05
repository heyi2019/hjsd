# 数据导入与迁移脚本（一次性执行记录）

本目录的 `*.py` 是**历史一次性脚本**，已在 2026-11-01 ~ 11-02 期间针对 WPS「黑金时代工作室」源数据执行完毕。
它们不是可重复运行的流水线，归档在此只为**保留「上线数据是怎么来的」的可追溯性**。

> **版本控制说明**：这些脚本因 `.gitignore` 曾整目录忽略而长期未入库，2026-11-04 起按「脚本与报告入库、数据产物不入库」的规则放行（见仓库根 `.gitignore`）。`*.json` / `*.csv` / `*.xlsx` 产物仍不入库。

## 使用前必读

1. **不要在现代库上直接跑。** 多数脚本硬编码了当时的表名、单号（`HS0029`、`HS0051`、`SR00001`、`KU_00090`）与金额，
   对当前数据结构与数据都已失效，跑下去会写错数。
2. **带「破坏性」标记的脚本会删业务数据**，执行前必须备份并确认目标库是 test 而非 release。
3. 库连接走环境变量（`DATABASE_URL`），没有命令行参数覆盖；跑之前先确认指向哪个库。
4. 需要复现某一步时，优先读脚本里的 docstring —— 每个脚本都写了「为什么做这一步」，比脚本本身更有价值。

## 一、解析与转换（源数据 → 结构化，只读）

| 脚本 | 作用 |
|---|---|
| `wps_import/parse_wps.py` | WPS 多维表 markdown 快照 → 结构化 JSON |
| `wps_import/make_table.py` | WPS 订单表 → ERP 口径标准导入表（CSV + XLSX） |
| `wps_import/wps_people.py` | WPS 回收账号登记（49 条）的回收人员昵称归集 |
| `wps_import/cross.py` | 交叉验证：用订单表人员标注反推账号表昵称归属 |
| `legacy_import/clean_legacy.py` | 老数据清洗：三份业务 Excel → 导入工作台标准模板 CSV |
| `legacy_import/build_form_aligned.py` | 按「订单台账」表单完整字段重排老数据 |
| `legacy_import/build_shortfall.py` | 产出 7 列订单清单 + 缺口工单两张表 |

## 二、导入（写库，建单/建档/建流水）

| 脚本 | 作用 |
|---|---|
| `wps_import/import_wps.py` | WPS 订单表 → ERP 导入（主入口） |
| `wps_import/import_wps_cashflow.py` | 导入非订单资金流水 90 行（投资款/房租日用/办公/薪资/运营/押金/退款） |
| `wps_import/import_inventory_only.py` | 补录「已售=否」的在库未售账号 |
| `wps_import/import_unpaid_inventory.py` | 补录两个「未售、未付款」在库账号 |
| `wps_import/import_k2_tip.py` | K2 打赏入账（交易 700 / 实得 66，备注 w428843） |
| `wps_import/create_users.py` | 按订单表实际出现的人员建 ERP 身份 |
| `wps_import/create_customer_k2.py` | 按 K2 记录备注建客户档案 |
| `wps_import/customers_from_wps.py` | WPS「需求」表 → 客户主数据 + 需求池，并停用联调遗留测试客户 |
| `wps_import/allocate.py` | 人员标注 → `order_profit_allocations` |
| `wps_import/fill_operators.py` | 回收员/售卖员 → 订单事件操作人 |
| `wps_import/set_inventory_operator.py` | 补录库存来源订单的入库负责人 |
| `wps_import/assign_stock_owner.py` | 回收人 → 库存账号 `stocks.note` |

## 三、补录与定点修正（改既有数据）

| 脚本 | 作用 |
|---|---|
| `wps_import/fix_gaps.py` | 补录导入遗留的三类数据（按 11-01 裁决口径） |
| `wps_import/backfill_ledger_gap.py` | 补录工作室收支里 ERP 缺失的 14 条 + 修正 1 条方向录反 |
| `wps_import/backfill_game_type.py` | 库存账号 `game_type` 统一回填为「王者荣耀」 |
| `wps_import/backfill_inventory_entry_at.py` | 入库时间改为业务日期（取较早者） |
| `wps_import/backfill_inventory_operator.py` | 入库负责人 → `form_extra.business_responsible_ids` |
| `wps_import/backfill_wallet_realname.py` | 按回收账号登记回填钱包实名 |
| `wps_import/fix_hs0029_profit.py` | HS0029 利润尾差 239.75 → 239.65 |
| `wps_import/fix_loss_order.py` | 修复被抹平的亏损单，利润落地 -313 |
| `wps_import/fix_penalty_attribute.py` | SR00001 违约金 51.50 属性改为「附加收入」 |
| `wps_import/fix_tip_direction.py` | ZC00001 打赏 188 元方向录反更正 |
| `wps_import/reclassify_hs0051_share.py` | HS0051 同行分成 277.60 改归「附加支出」 |
| `wps_import/register_hs0051_sell.py` | HS0051 补登售出（总额法 888 = 472 + 138.40 + 277.60） |
| `wps_import/_fix_indent.py` | 导入主循环 try 体移入 savepoint，移除整批 rollback |

## 四、审计与对账（只读，可安全参考）

| 脚本 | 作用 |
|---|---|
| `wps_import/audit_all.py` | 逐笔确认总表 v3，以 141 行完整源为基准 |
| `wps_import/audit_every_row.py`、`wps_import/audit_orders.py` | WPS 原始表 ↔ ERP 库逐笔核对（不聚合） |
| `wps_import/audit_orders_internal.py` | ERP 订单侧内部一致性审计 |
| `wps_import/audit_wps_ledger.py` | 工作室收支快照 + 与 ERP 流水比对 |
| `wps_import/compare_order_amounts.py` | 订单金额逐单对照，识别 SELL 口径不统一 |
| `wps_import/reconcile_orders.py` | 账号回收 151 条 ↔ 订单事件（BUY/SELL/COST）对账 |
| `wps_import/reconcile_bridge.py` | 资金口径差 68,143.98 的对账桥 |
| `wps_import/match_ledger.py` | 记账明细 ↔ 手工流水逐条匹配，列未匹配项 |
| `wps_import/verify.py` | 导入结果对账：逐单比对 WPS 金额与 ERP 事件金额 |
| `legacy_import/report.py` | 老数据清洗产出的核对工作簿 |

报告产物（入库）：`wps_import/导入对账报告_20261101.md`、`wps_import/逐笔核对报告_20261101.md`。

## 五、破坏性脚本（执行前必须备份 + 二次确认）

| 脚本 | 后果 |
|---|---|
| `wps_import/delete_all_customers.py` | **清空** `customers` 与 `customer_leads`（按 11-02 裁决重建客户主数据） |
| `wps_import/delete_ku90_91.py` | 删除 HS0055 / HS0056（KU_00090 / KU_00091）两笔未付款在库补录单 |
| `wps_import/cleanup_test_master.py` | 清理联调遗留的测试团队 / 合作方 / 用户（不动业务单据） |

CUS/REQ 编号删除后不回退（`document_sequences` 保持递增），清理后下一次从 CUS0017 / REQ0013 起。

## 六、沙箱试验（不碰真实库）

| 脚本 | 作用 |
|---|---|
| `wps_import/trial2.py` | 验证 SELL 双池拆分对订单利润与流水的影响（SQLite 空库） |
| `wps_import/trial_import.py` | 在库副本上验证 HS/DG 建单 + 事件 + 资金池拆分链路 |

## 七、工具

| 脚本 | 作用 |
|---|---|
| `wps_import/export_pg.py` | PG 逻辑备份，逐表导出 JSON（无 pg_dump 时的兜底） |

## 目录外的相关资产

- 源数据快照：`rawdata/原始数据/*.json`（5 份只读导出）
- 现行上线包与备份：`backups/`（不入版本库）
- 当前数据现状与治理结论：`docs/ERP_数据库架构检查与治理方案_V1.1_20261103.md`
