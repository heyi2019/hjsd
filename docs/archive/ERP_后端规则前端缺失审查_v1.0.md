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

## 0.3 第三轮处置状态（2026-10-24 已实施）

剩余 5 条 P0 全部清除（提交 `3e2c44a`）：

| 原编号 | 修复内容 | 改动 | 验证 |
|---|---|---|---|
| #11 | 资金性质 × 核算属性白名单 | `FundsPage.tsx`：核算属性选项按资金性质联动（镜像 `backend/app/finance/attributes.py`：BUSINESS 10 项 / EXTERNAL 3 项 / INTERNAL 1 项），切换自动改选合法项 | pools+field-definitions 40 |
| #28 | 核算属性标签缺 REFUND | `ACCOUNTING_ATTRIBUTE_LABEL` 补 REFUND=退款（原 12/13） | 同上 |
| #23 | AllocationRole 写死 OWNER | `OrdersPage.tsx`：分配四行 role 由隐藏 Input 改 Select（主责/采买/销售/服务），对齐 `policy/service.py:571-576` 校验 | orders 54 |
| #22 | EntityType 仅 customer | `labels.ts` 补全 8 域（与后端 `_ENTITY_LABELS` 用词一致）；`FieldsPanel.tsx` 实体 Select 解除 disabled（新建可选、编辑锁定）；列表映射同步生效 | field-definitions 26 |
| #14 | 冲销规则不可见 | `FundsPage.tsx` 冲销 Modal 补四条口径：继承原资金性质、核算属性固定冲销、直接已审核不经审核、不可重复冲销 | pools |
| #17 | 订单详情缺区块 | `OrdersPage.tsx` Drawer 新增资金流水/返点/分期合约（含期次）/审计记录/附件五个区块，数据来自 `GET /orders/{id}` 的 `OrderDetailOut`；`catalog.ts` 补 6 个详情类型 | orders 54 |

**至此 P0 24 条全部有处置**（#1-#24 中 #12 按勘误降为 P1 #62）。剩余：P1 24 条、P2 13 条，见正文。

## 0.4 P1 第一批处置状态（2026-10-24 已实施）

P1 小项批量清理第一批，共 10 条（提交 `62416da`）：

| 原编号 | 修复内容 | 改动 | 验证 |
|---|---|---|---|
| #31 | 对账差异原因口径 | `FundsPage.tsx` 补「账面与系统余额不一致时必填（系统余额=期初+已审核流水）」说明，与后端强制条件一致 | pools |
| #33 | 流水筛选下沉服务端 | `catalog.ts` `cashflowsApi.list` 补全 status/nature/fund_nature/accounting_attribute/category/created_by 六参；筛选栏新增资金性质/核算属性/类别三控件；池/方向/状态改服务端过滤，消除 2000 条上限盲区 | pools |
| #34 | 流水状态口径 | 筛选栏下补「事件过账流水直接已审核、独立流水需审核后才计入余额」 | pools |
| #29 | 资金流向四值 | 流水表新增「流向」列（labels.ts 新增 NATURE_LABEL） | pools |
| #25 | 期次表缺列 | 补「服务费率」列（后端 ScheduleOut.service_fee_rate 原本未展示） | installments |
| #27 | 取消分期文案错误 | 代分期（ADVANCE_PURCHASE）取消走后端 CANCEL_STOCK→IN_STOCK 账号回库，原写「代分期已结束」误导；Modal 提示与成功文案同步修正，测试断言随正 | installments |
| #45 | 质量中间态 | `qualityApi.update`（PATCH）接入，工单新增「开始处理」（OPEN→IN_PROGRESS）入口与三态中文标签 | quality |
| #46 | 质量主动扫描 | 新增「主动扫描」按钮（POST /quality/scan） | quality |
| #48 | 审计动作裸英文 | labels.ts 新增 AUDIT_ACTION_LABEL 全量 79 项（对齐 AuditAction 枚举），AuditPanel 动作列与筛选下拉均用中文 | audit |
| #49 | 审计筛选仅 2 参 | 补动作（选项来自 /audit-logs/actions）、操作人、开始/结束日期；对象类型改 ENTITY_TYPE_LABEL | audit |

**P1 剩余 14 条**（#26 已随 #25 相邻处理验证存在、#28 已在第三轮随 #11 修复、#30/#32/#35-#44/#47/#62），P2 13 条未动。〔本行及下文各「剩余」行均为当批处置后的时点快照，终态以 0.3 节末「P1 24 条全部清零」为准。〕

## 0.5 P1 第二批处置状态（2026-10-24 已实施）

订单/入口/策略域 8 条批量落地：

| 原编号 | 修复内容 | 改动 | 验证 |
|---|---|---|---|
| #35 | 订单编辑 PATCH | `catalog.ts` 补 `ordersApi.patch`（PATCH /orders/{id}）与 `Order.account_snapshot`/`link_status` 类型；`OrdersPage.tsx` 抽屉新增「编辑订单」入口与 Modal：成交日期/备注常改，DFQ 账号快照仅在密码可见（持 order.create）时整体回写，防止覆盖被后端隐去的密码；已有登记事件的订单按后端规则禁用核算字段只留备注 | orders 36 |
| #36 | 事件明细字段 | `OrderEvent` 类型补 portion/offset_event_id/reason/refund_responsibility/posted_at；抽屉「动作记录」行展示 动作+event_no、金额+份额（本金/利润/总额）、日期+操作人、冲销来源 #id、责任方、交付方式、未过账标记；labels 三张映射表随后端枚举 | orders 36 |
| #37 | 指定被冲销事件 | 取消交易 Modal 新增「被冲销动作」下拉（已过账 BUY/COST/SELL 按剩余可冲过滤，默认沿用最后一笔）+「冲销金额」（默认该动作剩余可冲，改选自动重置）；提交带 offset_event_id + amount，前端校验不超剩余；支持部分冲销 | orders 36（含部分冲销守门用例） |
| #38 | 账号下架 VOID | `InventoryPanel.tsx`「下架」按钮/菜单项由 `message.info` 占位改为真实流程：加载执行明细找剩余可冲 BUY 事件 → 「下架登记」Modal（原因必填）→ postEvent CANCEL（offset=BUY、全额）→ 账号 VOID；找不到可冲买入流水时 warning 提示，不再静默无操作 | accounts 13（3 条新守门） |
| #39 | 回收转售 RESELL | `InstallmentsPanel.tsx`：CLOSED/OVERDUE/DEFAULTED 且已回收未出售的合约新增「登记出售」按钮 + Modal（选出售订单/日期/说明）调 `installmentsApi.resale`；删除 catalog 中重复且改名的 `sale` 方法；原「请到库存中心售出，系统自动关联」误导文案（后端并无自动关联）随按钮替换 | installments 24（含登记出售守门） |
| #42 | 导入来源补 LEAD | `ImportWorkbench.tsx` source_kind 选项补「需求」（STANDARD_LEAD，对齐 `ImportSourceKind`），IMPORT_TEMPLATES 补需求 CSV 模板（客户ID/需求类型/预算/需求内容/负责人ID/备注） | imports 22（含 LEAD 守门） |
| #43 | 订单规则快照 | `OrdersPage.tsx` 抽屉新增「规则快照」区块：`policyApi.orderSnapshot` 读取，found 时展示 policy_version_id 与 REBATE/COMMISSION 固化参数（对象值 JSON 化），未固化时说明「建单时无生效的返点/提成规则」；无权查看时静默降级不阻断详情 | orders 36（含快照守门） |
| #44 | 规则生效期 resolve | `PolicySettingsPanel.tsx` 新增「生效期自查」按钮 + Modal：规则编码（受控枚举）/日期/适用范围（GLOBAL 或按人员·类型·池 + 范围 ID）→ `policyApi.resolve`，展示命中版本（v号/生效期/状态/参数）或「该日该作用域没有生效的规则版本」；门控按后端 policy.manage/policy.approve 任一（同 settlePermission 先例取用户实际持有的码） | policy 9（含命中/未命中守门） |

配套修正：`catalog.ts` `policyApi.resolve` 补 scope_type/scope_id 可选参数（默认 GLOBAL，与后端 Query 一致）。

### 0.3 P1 第三批处置记录（展示基建类，提交 7850f1f + 975a5ac）

| # | 差异 | 修复 | 验证 |
|---|---|---|---|
| #30 | 系统余额口径不可见 | `FundsPage.tsx` 对账页补口径说明段（截至对账日「已审核」流水累计、待审核/已拒绝不计入、按池内账户对账时另含该账户期初余额、差异 = 账面余额 − 系统余额）；「系统余额」列表头加 Tooltip 同口径 | pools 48 |
| #32 | 对账唯一约束后置报错 | 新增对账 Modal「对账账户」字段补唯一约束说明（同一资金池+对账账户+日期）；提交前按已加载记录做客户端预检，命中重复 warning 阻断并提示调整日期或账户，不再让用户直接吃后端校验错误 | pools 48（含重复预检守门） |
| #40 | 孤儿单（ORPHAN）无筛选入口 | `catalog.ts` Order 补 `link_status`（移除后段重复声明）；`labels.ts` 补 `LINK_STATUS_LABEL` 四态；OrdersPage 筛选栏新增「关联状态」下拉（数量联动），台账加「关联」列（StatusTag 带 label），详情抽屉补关联状态行 | orders 37（含孤儿单筛选守门） |
| #41 | capital_type 建单不可覆盖 | `CreateBusinessModal.tsx` 新增「资金性质」选择（默认跟随业务类型定义，allowClear 可显式覆盖 STOCK/ZERO/CREDIT），两个创建分支均随 payload 提交 `capital_type`；OrdersPage 详情补资金性质行 | quick 21（含 ZERO 覆盖守门） |
| #47 | 编号序列不可见 | `catalog.ts` 补 `sequencesApi`（GET /foundation/sequences）与 `DocumentSequence`；新建 `SequencesPanel.tsx` 只读面板（12 编号域中文标签 + 序列键/前缀/补齐位数/当前值/下一编号，排查断号/跳号）；SettingsPage 新增「编号序列」Tab，`order-type.manage` 门控 | field-definitions 45（含展示+失败分支守门） |
| #62 | 自有权益口径缺失 | `FundsPage.tsx` 统计卡新增第四项「自有权益合计」：按 PoolOwnership 口径仅累计 OWNED 归属池的现金头寸（CUSTODY/THIRD_PART 只计头寸不计权益），归属以资金池主数据为准；卡下补口径说明（押金占用仍是自有资金，权益不扣减占用） | pools 48（含权益合计守门） |

配套修正：新增共享类 `.ui-filter-select` / `.ui-card-hint`（替代内联样式，`no-inline-style` 守卫）；权益合计以 `pools` 主数据为归属真来源，不依赖 balance 载荷是否带 `pool_id`。

**P1 24 条全部清零**（口径 5 + 状态机/能力页 12 + 订单/入口/策略 8 + 展示基建 6... 分四批落地：3f078ea/3fdcc2d、9303fe3/bd86485/9a42913、3e2c44a/c883b27、62416da、96847b6/e2d3b98、7850f1f、975a5ac）。P2 13 条未动。

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

### 3.1 P2 第一批处置记录（2026-10-24 已实施，提交 2e946bd）

前置逐条复核结论（对当前代码重新取证，非照搬初表）：

- **#53 已不成立**：event_no（#36 修复）、flow_no（FundsPage 流水号列）、rebate_no（RebatesPanel + 订单抽屉）均已展示。
- **#51 不成立**：押金功能（占用/释放/损失登记）完整落在 FundsPage，仅为目录结构说明，无需处理。
- **#52 升级为跨端缺口**：Order 表有 commission_mode/commission_payer 字段与 CHECK 约束，但 `orders/schemas.py` 的创建/更新契约**根本没有暴露这两个字段**——不是前端展示问题，需后端先在 OrderCreate/OrderUpdate 补契约，前端再录入。本批不动，列为后续项（后在 3.2 复核结案）。

已修复 9 条：

| # | 修复 | 验证 |
|---|---|---|
| #50 | StatusTag 补 `CONVERTED`（已转化）；顺手补通知已读态 `READ/UNREAD`（前端本地码，原先也裸英文） | ui_guards |
| #58 | StatusTag 补 `UNLINKED_TRANSFER`（单边划转未关联）；两码均为独有码无跨域冲突 | ui_guards |
| #59 | 对账表状态列调用点显式传 label（OPEN→未核销、RESOLVED→已核销），不动全局 map（OPEN/RESOLVED 与质量域共用） | pools 深覆盖守门 |
| #60 | `FUND_NATURE_LABEL`/`ACCOUNTING_ATTRIBUTE_LABEL` 上移至 `labels.ts` 共享，ReportsPage 资金性质/核算属性列改用映射 | reporting 守门 |
| #56 | DailyFunds 加日期选择（默认今天）→ `dailyFunds({ on })`，日期变更 reload | reporting 守门 |
| #61 | Cashflow 类型补 reviewed_by/reviewed_at/reversal_of_id 等 6 字段；流水表新增「审核追溯」列（审核人 · 审核时间 · 冲销来源） | pools 深覆盖守门 |
| #54 | AdditionalFeeFields 新增「设计费」金额行；initialCosts 增 `flow_category: "DESIGN"` 分支，不再塞进 OTHER | quick 守门 |
| #55 | 游戏类型新建表单补「默认类型」复选框，create payload 带 is_default（编辑态隐藏，后端 update 不支持） | react 守门 |
| #57 | notificationsApi.list 补 unread_only；面板加「仅看未读」勾选，统计卡筛选态改显「未读列表」，空文案随切换 | react 守门 |

**P2 状态：12 条中 9 条已修复、2 条复核不成立（#51/#53）、1 条升级跨端缺口待后端（#52，已在 3.2 复核结案）。**

> 备注：#57 的 offset 分页参数本次只补了 unread_only——流水/通知列表的分页 UI 本身未接线（DataTable onPageChange 为空实现），offset 留待分页重做时一并处理，避免留一个「能传但无入口」的半成品参数。

### 3.2 P2 第二批处置记录（2026-10-24，#52 跨端缺口复核结案）

对 #52 重新取证（git 历史 / 守门用例 / 数据库三线核对），初表与第一批的「跨端缺口」判断**前提失效**：

- **该功能已于 2026-10-18 被产品裁决裁撤**：提交 `16581fb`「fix: 删除已取消的代挂与返点遗留逻辑」把 DG 代挂结算条款整体从 service 契约删除——`create_order` / `update_order` 的 `commission_mode` / `commission_payer`（及同批的 `listing_price` / `service_fee` / `expected_settlement_date`）参数、校验、落库全部移除，并新增守门用例 `test_dg_service_rejects_removed_commission_terms` 锁定「service 不再接受这些参数」（传参即 TypeError）。审计初表只看到 `domain/trade.py:144-159` 的 DB CHECK 约束仍在，误判为「契约未暴露」。
- **DB 列与 CHECK 约束仍在，但已无任何业务读取方**：全仓 grep 确认除 ORM 定义外没有代码读 `Order.commission_mode / commission_payer`（R3 提成对账走 `OrderProfitAllocation`，与这两个字段无关）；dev 库 153 笔订单 **0 笔**有提成数据，属纯孤儿列。
- **前端零引用**：建单 / 编辑 / 详情均无提成控件——初表「无控件」属实，但根因是功能已裁撤，不是漏接。

**结论：#52 复核不成立（按既定产品裁决维持关闭）**，与 #51/#53 同样结案，不再排期。2026-10-24 用户裁决：维持关闭，以下两条后续事项均不排期：

1. **重开提成登记**：不重开。若未来业务上确需恢复，属「重开已裁撤功能」——需先撤守门用例 `test_dg_service_rejects_removed_commission_terms`、重开 service 契约（成对 / 仅 DG / 枚举校验）与前端录入，按先报后改流程单独实施；
2. **孤儿列清理**：暂不删列。`commission_mode` / `commission_payer`（及同批裁撤的 `listing_price` / `service_fee` / `expected_settlement_date`）已确认无历史数据，保留原位不影响任何读写；如未来清理，删列会动 orders 表结构与 CHECK 约束，需单独评估迁移风险。

**P2 整体状态（2026-10-24 收口）：12 条全部闭环——9 条已修复（提交 2e946bd）、3 条复核不成立（#51/#53/#52），无遗留待办项。**

---

## 4. 处置建议（按投入产出排序）

1. **先修口径类（第 1、12、18 条）**：这三条是「算错/静默失效」，不是「缺功能」，改动量小（一个公式、一个汇总过滤、一个 Select 化），风险收益比最高。
2. **再补状态机动作入口（第 2-9 条）**：属于同一类改动（加按钮 + 调现有 POST 端点），可批量做；其中 #3 违约登记涉及 DEFAULTED 态全链路，建议单独评估是否业务上需要。
3. **权限点补注册（第 24 条）**：一行改动，但必须与 `docs/ERP_权限矩阵_v1.0.md` 同步，否则文档与代码再次分叉。
4. **能力类（#10 资金池账户、#15 订单关联、#19-21 配置闭环）**属于新增页面级工作，建议按迭代计划排期，不宜与口径修复混在一起做。

> 说明：本表只做「差异呈现」，不含修复方案与排期。是否修、按什么顺序修，需你裁决后进入实施。改动涉及共享模块（如 `session.tsx` 权限白名单、`catalog.ts` 类型定义）时，按既有纪律走「先报后改」。
