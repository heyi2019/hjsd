# ERP 后端规则 × 前端展示 差异审查

- 文件编号：ERP-SYS-REV-001
- 运行域：工作经营 / ERP 前后端一致性
- 阅读对象：何一（裁决）、前端开发
- 编写日期：2026-10-23
- 编写人：WorkBuddy（自动取证 + 人工复核）
- 审查范围：backend/app（策略引擎、状态机、枚举、校验规则、权限点） × frontend/src（页面展示与操作入口）
- 取证方式：后端逐文件通读 + 前端全仓 grep 反证；所有「前端无」结论均为非测试代码零命中后判定，非凭印象

---

## 0. 结论摘要

共确认 **61 条**「后端有规则、前端未展示」差异：**P0 24 条 / P1 24 条 / P2 13 条**。

三条最需要优先处置（其余见正文分级表）：

1. **分期总应收口径前后端已分叉**（不是缺功能，是算错）：后端 `total_receivable` 含末期调整与减免，前端注释明确只算「首付 + 每期 × 期数」，且创建分期时硬编码 `adjust_final_period: true`，误差必然触发。
2. **后端 8 个已实现的状态机动作在 UI 上零入口**：提前结清、违约登记、期次减免、期次展期、逾期标记、返点冲销、订单关联、已售账号再买入 —— 规则写在代码里，业务上走不到。
3. **两个后端权限点前端未注册**（`finance.period.lock`、`finance.order.event.post`），导致 UI 权限边界与后端真实边界不一致：有 `deposit.post` 的用户看得见月结按钮、点下去 403。

---

## 0.1 第一轮处置状态（2026-10-23 已实施）

按第 4 节顺序实施了「口径类」修复，共 5 处改动，均为已实测：

| 原编号 | 修复内容 | 改动 | 验证 |
|---|---|---|---|
| #1 | 分期总应收口径 | 后端 `installments/schemas.py`：`InstallmentOut` 增加 `final_period_adjustment`，并用 Pydantic `computed_field` 下发 `total_receivable`（口径唯一来源，与 `service.total_receivable` 一致）；前端 `catalog.ts` 补类型、`InstallmentsPanel.tsx` 改为读取后端值（旧响应回落本地公式） | 后端 71 passed；手工验证 100+150×6+20−50=970 ✓ 且出现在 JSON |
| #18 | 规则编码自由文本 → 受控枚举 | `PolicySettingsPanel.tsx` 新增 `POLICY_CODE_OPTIONS`（六类，与后端 `PolicyType` 一致），`policy_code` 由 Input 改 Select | 策略面板 7/7 passed（同步更新 2 个基于旧行为的用例） |
| #24 | 权限点补注册 | `session.tsx` 补 `finance.order.event.post`、`finance.period.lock`；`ROLE_PERMISSIONS` 五个角色全部对齐后端 `core/security.py` | session 9/9 passed |
| #13（部分） | 月结按钮门控 | `FundsPage.tsx:723` 由 `deposit.post` 改为 `finance.period.lock` | FundsPage 8+6 passed |
| — | 文档同步 | `docs/ERP_权限矩阵_v1.0.md` 补两行权限点并标注代码为权威源 | — |

**未修**：第 12 条按勘误降级为 #62，未改代码。

## 0.2 第二轮处置状态（2026-10-24 已实施）

第 2 组（8 个状态机动作入口）与第 3 组（4 个能力页面）全部落地，共 10 个文件、两个提交（`9303fe3` 动作入口、`bd86485` 配置域）：

| 组 | 修复内容 | 改动 | 验证 |
|---|---|---|---|
| 第 2 组 | 分期 5 动作 | `InstallmentsPanel.tsx`：提前结清、违约登记、期次减免、期次展期、逾期标记（批量），全部调后端既有 POST 端点；期次列表新增应收/减免/宽限列 | installments 11/11 |
| 第 2 组 | 返点冲销 + 结算明细 | `RebatesPanel.tsx`：reverse 入口、结算明细、`expected_on` 逾期列与统计 | rebates 8/8 |
| 第 2 组 | 订单关联 | `OrdersPage.tsx`：详情抽屉关联单区块 + 新建关联（SOURCE/FOLLOW_UP + split_ratio/split_amount） | orders+accounts 109 |
| 第 2 组 | 已售账号再买入 | `InventoryPanel.tsx`：「更多⌄」→ 再买入（仅 SOLD），走后端 BUY 事件触发 SOLD→BUY_STOCK→IN_STOCK | 同上 |
| 第 3 组 | 池内账户主数据 | 新增 `pools/PoolAccountsPanel.tsx`，FundsPage 加「池内账户」Tab；pool-accounts 5 端点全接入（列表/池筛选/新建/编辑/启停）；归属 OWNED/CUSTODY/THIRD_PART 标注「计入权益/只计头寸」 | pools 8+6 |
| 第 3 组 | 业务类型新建 + 资金路由 | `OrderTypesPanel.tsx`：新建类型（code/名称/资金性质/编号前缀/排序）；「路由」Modal 配置份额+资金性质→资金池+优先级；影响预览补传 fund_nature | field-definitions 26 |
| 第 3 组 | 导入更正批次 | `ImportWorkbench.tsx`：已确认批次「更正」入口（JSON 行数组+理由），走后端 corrections，原批次只读、更正分层可追溯 | imports 22 |

配套修正：`catalog.ts` 补 `poolAccountsApi`、`orderTypesApi.setRoute`、`OrderLink` 类型与 `fund_nature` 参数；`OrderTypesPanel.test.tsx` 同步 2 个因行为变更滞后的断言。

**遗留（未在范围）**：分期违约登记的业务必要性（DEFAULTED 全链路）建议业务侧确认后启用；`OrderLink` 无删除入口（后端亦未提供）。

---

## 1. P0 — 规则已在后端生效，但前端完全不可见 / 不可达

判定标准：会直接导致误解账、误操作，或后端规则在 UI 上永不可达。

### 1.1 分期与回款域（9 条）

| # | 规则 | 后端证据 | 前端现状 | 影响 |
|---|---|---|---|---|
| 1 | **总应收口径** | `installments/service.py:233-239`：`首付 + 每期×期数 + final_period_adjustment − waived_amount` | `InstallmentsPanel.tsx:161-163` 注释即写明「总应收 = 首付 + 每期 × 期数」；`waived_amount`/`final_period_adjustment` 未进前端类型；`InventorySaleModal.tsx:123` 硬编码 `adjust_final_period:true` | 前端应收与后端系统性不符，分期售出场景必错，直接误导对账与催收 |
| 2 | 提前结清 | `installments/router.py:208-226`；`service.py:935-1000` | 无入口（全仓 grep `settle-early` 零命中） | 只能逐期手工收款 |
| 3 | 违约登记 DEFAULT | `installments/router.py:228-245`；`service.py:1003-1039` | 无入口 | DEFAULTED 态不可达，其后续 PAYMENT/CLOSE 分支（`state_machine.py:60`）成死代码，风险资产无法标记 |
| 4 | 期次减免 waive | `installments/router.py:107-128`；`service.py:776-854` | 无入口（grep `waive` 零命中） | 经授权减免无登记入口，用户看到「未收满却已结清」无法解释 |
| 5 | 期次展期 extend | `installments/router.py:131-151`；`service.py:857-900` | 无入口（grep `extend` 零命中） | 逾期协商结果落不到系统 |
| 6 | 逾期标记 mark-overdue | `installments/router.py:327-339`；`service.py:1292-1359` | 无入口 | 逾期口径（`due_on < as_of` 严格小于）不可见，无法主动复核 |
| 7 | 返点冲销 reverse | `finance/router.py:697`；`finance/rebates.py:350-393` | 无入口 | 错录返点无法更正，只能改库，违反冲销留痕设计 |
| 8 | 返点结算明细 | `finance/router.py:685`（`GET /rebates/{id}/settlements`） | 无入口（`catalog.ts` 仅 list/create/settle） | 分次到账无历史可查 |
| 9 | 返点逾期视图 | `finance/router.py:604`；`rebates.py:500-522`（含 `expected_on` 与逾期天数） | 无入口，`expected_on` 未定义 | 后端已生成逾期通知，但列表无逾期列，催收无抓手 |

### 1.2 资金 / 流水 / 对账域（5 条）

| # | 规则 | 后端证据 | 前端现状 | 影响 |
|---|---|---|---|---|
| 10 | **资金池账户主数据** | `finance/pool_accounts.py:28-219`；`finance/router.py:51-125`（5 个端点） | 全前端零命中（无 API、无页面） | 账户维度余额/归属/启停不可维护；流水只能挂池不挂账户，对账与报表「资金账户」列恒为「未指定账户」 |
| 11 | 资金性质 × 核算属性白名单 | `finance/attributes.py:7-35`；校验 `cashflows.py:147-149` | `FundsPage.tsx:782-783` 两个 Select 各自独立，13 个属性全量可选 | 非法组合必现 422，用户无任何事前提示 |
| 12 | 资金池归属的核算口径 | `domain/enums.py:24-29`：OWNED 计入权益，CUSTODY/THIRD_PART 只计现金头寸 | 只显示中文名，且现金头寸无差别相加（`FundsPage.tsx:312-314`） | 见下方【勘误】——本条已从 P0 降级 |
| 13 | 期间锁定边界与后果 | `core/periods.py:30-43` + 13 处守卫（orders/finance/accounts） | 各表单均无「当前账期已锁定」提示；`finance.period.lock` 权限点未在 `session.tsx:8-33` 注册，按钮改用 `deposit.post` 门控（`FundsPage.tsx:723`） | 锁定月录入后才发现 409；权限边界在 UI 上失真（看得见、点下去 403） |
| 14 | 冲销流水不经审核直接入账 | `finance/cashflows.py:304-321`（继承原资金性质、强制 REVERSAL 属性、直接 APPROVED） | 无说明 | 用户以为冲销仍需审核会重复追审；两条口径完全不可见 |

### 1.3 订单 / 事件 / 库存域（3 条）

| # | 规则 | 后端证据 | 前端现状 | 影响 |
|---|---|---|---|---|
| 15 | 订单关联（SOURCE/FOLLOW_UP + split_ratio/split_amount） | `orders/router.py:482-507`；`orders/service.py:424-493` | 全仓 grep `links`/`relation_type`/`split_ratio` 零命中；`Order` 类型无该字段 | 上下游单与利润拆分口径完全不可建、不可看 |
| 16 | 已售账号再次买入 / COMPLETED 订单 BUY 回滚 | `state_machine.py:26,35-36`；`orders/events.py:138-146,372-376` | 「售出」按钮 `status !== 'IN_STOCK'` 即禁用（`InventoryPanel.tsx:278`）；订单页无 BUY 入口 | 退货重入库、二次买入只能另建新单，成本与历史轨迹断裂 |
| 17 | 订单详情的资金流 / 分期 / 返点 / 审计 / 附件区块 | `orders/schemas.py:223-233`；`orders/router.py:107-224` | Drawer 仅 Descriptions + 事件三列（`OrdersPage.tsx:466-494`） | 订单侧无法核账，只能绕去库存中心 |

### 1.4 规则配置与治理域（7 条）

| # | 规则 | 后端证据 | 前端现状 | 影响 |
|---|---|---|---|---|
| 18 | 规则编码六类（REBATE/COMMISSION/INSTALLMENT/WRITE_DOWN/REFUND/DG_MIXED） | `domain/enums.py:341-349`；硬消费点 `rebates.py:116`、`orders/service.py:321-324`、`installments/service.py:403` | `PolicySettingsPanel.tsx:354-356` 自由文本 Input（placeholder「例如 REBATE_RATE」） | 编码拼错即**静默不命中**快照，返点/提成/分期规则全部失效且无报错 |
| 19 | 新建业务类型 | `foundation/router.py:206-222`；`foundation/order_types.py:27-98`（含 sequence_prefix/capital_type） | `orderTypesApi.create`（`catalog.ts:460`）定义未调用，页面无新建入口 | 新增业务只能改库 |
| 20 | 资金路由配置（portion/fund_nature/pool/priority/is_active） | `foundation/router.py:277-302`；`order_types.py:182-252` | 无 setRoute 方法，`routes` 未调用 | 业务类型启用前必须配路由（`order_types.py:142-159`），UI 无法完成启用闭环 |
| 21 | 导入更正批次（MIG-01-08） | `imports/router.py:171-190`；`service.py:627-695` | `importsApi.corrections`（`catalog.ts:962`）定义零调用 | COMMITTED 禁回滚（`service.py:588-602`）+ 无更正入口 = **死锁** |
| 22 | EntityType 8 个活字段挂载域 | `domain/enums.py:148-158`；`parties/_common.py:28-45` | `labels.ts:69-71` 仅 `customer` 一项；`FieldsPanel.tsx:175` Select 被 disabled | 订单/账号/分期/池/流水/需求/合作方 7 域字段无法定义，列表显示裸英文 |
| 23 | AllocationRole 四角色（OWNER/BUYER/SALES/SERVICE） | `domain/enums.py:352-358`；校验 `policy/service.py:571-576` | `OrdersPage.tsx:194` 三元两端均写死 `"OWNER"` | 采买/销售/服务角色永远无法体现 |
| 24 | 权限点缺口 | `core/security.py:67,82`（`finance.period.lock`、`finance.order.event.post`） | `session.tsx:8-33` 前端 26 点 vs 后端 27 点，缺此两项 | 前端权限矩阵与后端不一致，按钮显隐判据失真 |

### 【勘误】原第 12 条（资金池归属口径）降级说明

初版判定为「无差别相加 → 虚增权益」。复核 `FundsPage.tsx:599` 后确认：三个统计卡的标签是「现金头寸合计 / 可用余额合计 / 押金占用」，**并非**「自有资金 / 权益」。后端语义恰恰是 CUSTODY、THIRD_PART 只计现金头寸，因此把全部池的 `cash_balance` 相加作为「现金头寸合计」与后端一致，不构成虚增权益。

真实缺口窄化为一句话：**没有单独展示「自有权益（OWNED）合计」这一口径**。故本条由 P0 降为 P1（见 2.x 节第 62 条）。此处记录勘误，不因复核而抹去原判定。

---

## 2. P1 — 看得到结果，看不到规则口径 / 能力被降级

| # | 域 | 规则 | 后端证据 | 前端现状 |
|---|---|---|---|---|
| 25 | 分期 | 期次表缺减免/费率/收款日列 | `installments/schemas.py:62-73` | `catalog.ts:343-351` 缺失，仅 5 列 |
| 26 | 分期 | ScheduleStatus PARTIAL / WAIVED 无中文 | `enums.py:304-309` | 复用合约状态标签，显示裸英文 |
| 27 | 分期 | 取消分期账号回流规则文案错误 | `service.py:740-747`（CANCEL_STOCK→IN_STOCK） | `InstallmentsPanel.tsx:151-152` 写「代分期已结束」，误导 |
| 28 | 资金 | 核算属性缺 REFUND（12/13） | `enums.py:213-228` | `FundsPage.tsx:41-54`，退款流水显示裸码 |
| 29 | 资金 | Nature 4 值不暴露，靠隐式推导 | `enums.py:198-209`；`cashflows.py:125-131` | `FundsPage.tsx:199`，非法组合触发 422 且用户看不见入参 |
| 30 | 资金 | 系统余额口径（期初+已审核流水，剔除 PENDING/REJECTED） | `reconciliation.py:37-59` | 只显示差异数字（`FundsPage.tsx:532`） |
| 31 | 资金 | 对账差异≠0 原因非必填 | `reconciliation.py:145-153` | `FundsPage.tsx:811` 非必填 → 422 |
| 32 | 资金 | 对账唯一约束（池+账户+日期+账户标签） | `trade.py:401-407` | 无去重提示，重复对账直接 409 |
| 33 | 资金 | 流水列表 6 个服务端过滤器 | `finance/router.py:252-266` | `catalog.ts:655-662` 只传 5 参 |
| 34 | 资金 | 派生流水直接 APPROVED vs 独立流水 PENDING | `trade.py:373-375` vs `cashflows.py:179` | 状态列统一显示「已审核」，无解释 |
| 35 | 订单 | 订单编辑 PATCH /orders/{id} | `orders/router.py:510-526` | 无 `ordersApi.patch`，建错单只能冲销 |
| 36 | 订单 | 事件明细字段（event_no/offset_event_id/reason/refund_responsibility/portion） | `orders/schemas.py:201-220` | 动作记录只渲染动作/操作人/日期 |
| 37 | 订单 | 订单侧部分冲销 / 指定被冲销事件 | `orders/events.py:261-289` | 固定冲最后一笔（`OrdersPage.tsx:273-284`），易冲错 |
| 38 | 订单 | 账号下架 VOID | `state_machine.py:26,32` | 按钮仅 `message.info`（`InventoryPanel.tsx:303-311`） |
| 39 | 订单 | 回收转售登记 RESELL | `installments/service.py:1128-1168` | `catalog.ts:615-616` 定义零调用 |
| 40 | 订单 | link_status（ORPHAN / UNLINKED_TRANSFER） | `orders/schemas.py:152` | Order 类型无此字段，孤儿单不可筛 |
| 41 | 订单 | capital_type（STOCK/ZERO/CREDIT）按单覆盖 | `orders/events.py:742-753` | 建单不传不展示，资金性质只能取业务定义 |
| 42 | 导入 | 来源缺 STANDARD_LEAD | `enums.py:379` | `ImportWorkbench.tsx:549-554` 仅 4 项 |
| 43 | 策略 | 订单规则快照追溯 | `policy/router.py:209-223` | `policyApi.orderSnapshot` 未调用，「历史口径不因改版变化」不可验证 |
| 44 | 策略 | 规则生效期解析 resolve | `policy/router.py:142-164` | `policyApi.resolve` 未调用，配错难自查 |
| 45 | 质量 | IN_PROGRESS 中间态 | `quality/router.py:100-113` | 无 update 方法，退化为「未关闭/已关闭」两态 |
| 46 | 质量 | 主动扫描 /quality/scan + 月度指标 /metrics | `quality/router.py:34-41,44-54` | 无入口，只能被动等工单 |
| 47 | 基础 | 编号序列 /sequences（12 域当前值+下一编号） | `foundation/router.py:329-351` | 全仓零命中，断号/跳号不可发现 |
| 48 | 审计 | AuditAction 70+ 动作裸英文 | `enums.py:412-495` | `AuditPanel.tsx:22` 直接渲染原值 |
| 49 | 审计 | 审计筛选仅 2 参 | `audit/router.py:29-36,74-82` | `AuditPanel.tsx:15` 只传 entity_type/entity_id |
| 62 | 资金 | 缺「自有权益（OWNED）合计」口径（原第 12 条降级） | `domain/enums.py:24-29` | 三个统计卡只给「现金头寸合计」，未拆分 OWNED / CUSTODY / THIRD_PART，自有权益口径不可读 |

---

## 3. P2 — 展示细节缺失 / 入口冗余

| # | 域 | 规则 | 后端证据 | 前端现状 |
|---|---|---|---|---|
| 50 | 客户 | LeadStatus CONVERTED 裸英文 | `enums.py:110` | `StatusTag.tsx` 无映射 |
| 51 | 资金 | 押金无独立页面 | `cashflows.py:380,453-458,542` | `/deposits/pages/` 空目录，功能落在 FundsPage |
| 52 | 订单 | 提成 commission_mode / payer 无录入 | `trade.py:145-152` | 无控件，只能走接口/导入 |
| 53 | 订单 | 编号 event_no/cashflow_no/rebate_no 不展示 | `core/business_numbering.py:23-68` | 仅 inst_no 展示 |
| 54 | 订单 | COST 的 flow_category 缺 DESIGN | `orders/events.py:216` | 仅 FEE/OTHER，设计费全落 OTHER |
| 55 | 基础 | 游戏类型新建不传 is_default | `game_types.py:29,49-50` | 需两步操作 |
| 56 | 报表 | 资金日报 `on` 指定日期 | `reporting/router.py:92` | `ReportsPage.tsx:335` 固定不传 |
| 57 | 通知 | unread_only / offset | `notifications/router.py:25-27` | 只传 limit |
| 58 | 资金 | StatusTag 缺 UNLINKED_TRANSFER 文案 | `enums.py:88` | 显示裸英文码 |
| 59 | 资金 | 对账状态文案错位 | `enums.py:405-409` | 显示「未结算/已处置」，应为「未核销/已核销」 |
| 60 | 报表 | 资金属性分析显示裸码 | 上游 13 值 | `ReportsPage.tsx:387-388` 无 label 映射 |
| 61 | 资金 | 审核人 / 审核时间 / reversal_of_id 不展示 | `cashflows.py:225-226,322` | 前端零命中，无法追溯 |

---

## 4. 处置建议（按投入产出排序）

1. **先修口径类（第 1、12、18 条）**：这三条是「算错/静默失效」，不是「缺功能」，改动量小（一个公式、一个汇总过滤、一个 Select 化），风险收益比最高。
2. **再补状态机动作入口（第 2-9 条）**：属于同一类改动（加按钮 + 调现有 POST 端点），可批量做；其中 #3 违约登记涉及 DEFAULTED 态全链路，建议单独评估是否业务上需要。
3. **权限点补注册（第 24 条）**：一行改动，但必须与 `docs/ERP_权限矩阵_v1.0.md` 同步，否则文档与代码再次分叉。
4. **能力类（#10 资金池账户、#15 订单关联、#19-21 配置闭环）**属于新增页面级工作，建议按迭代计划排期，不宜与口径修复混在一起做。

> 说明：本表只做「差异呈现」，不含修复方案与排期。是否修、按什么顺序修，需你裁决后进入实施。改动涉及共享模块（如 `session.tsx` 权限白名单、`catalog.ts` 类型定义）时，按既有纪律走「先报后改」。
