# ERP_页面原型与交互说明_V1.1

| 项 | 内容 |
|---|---|
| 文件编号 | ERP-UI-INT-V1.1 |
| 运行域 | 工作经营 |
| 阅读对象 | 前端开发、测试、业务验收人 |
| 编写日期 | 2026-10-20 |
| 编写人 | 何一（依据 `frontend/src` 源码逐文件取证整理） |

> **本文件性质**：描述**当前前端已实现的页面结构与交互**，不是待建方案。凡与代码不一致的旧描述一律以代码为准。
> **上游依据**：[ERP_PRD_F01_功能规格说明书](ERP_PRD_F01_功能规格说明书.md)、[ERP_PRD_v1.2_当前实现版](ERP_PRD_v1.2_当前实现版.md)。
> **证据口径**：文中所有页面/Tab/按钮均对照 `frontend/src` 源码核实，关键处标注 `文件:行号`。

## 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| V1.0 | 2026-10-18 | 首版。以 PRD 为源头描述页面规划，含 URL 路由、业务作业队列、订单详情多 Tab 等**未落地的设想**。 |
| V1.1 | 2026-10-20 | 按前端现状全文重写：① 删除不存在的路由/`业务作业` Tab/订单详情 Tab；② 六个一级入口的 Tab 清单全部按源码重列（业务中心 5→3、资金中心 5→6、经营中心 6→13、设置 5→10、客户中心 2→3）；③ 新增「应用外壳与全局交互」章（主题三态、用户中心、⌘K、移动端「管理」入口、懒加载）；④ 新增「已知交互缺口与待办」章，收录本次审查的高优先缺陷。 |

---

## 1. 设计取向

沿用 V1.0 五条原则，并按现状收紧表述：

| 原则 | 现状约定 |
|---|---|
| 业务统一入口 | HS（回收）、TH（提号）、DG（代挂）、DFQ（代分期）统一从「新建订单⌄」下拉或工作台入口卡进入 |
| 资金统一入口 | 资金池、流水、押金、对账、异常与月结、返点同在「资金中心」内切 Tab |
| 经营统一入口 | 报表、数据中心、质量、搜索、审计、附件同在「经营中心」内切 Tab，不占一级菜单 |
| 历史收起 | 标准导入放在「设置」内，由 `import.manage` 门控，不出现在常用导航 |
| 三级轻量化 | 三级只允许为 Tab、抽屉或弹窗，不再增加左侧层级 |
| **工作台不复制数据** | 工作台是纯动作入口；金额类总览统一归「经营中心 · 数据中心」，避免两个页面各算一套数 |

---

## 2. 应用外壳与全局交互

### 2.1 路由（HashRouter，2026-10-20 路由批次接入）

前端已引入客户端路由。`main.tsx:40-42` 用 `<HashRouter>` 包裹 `<ThemedApp />`，为整个应用提供路由上下文；`AppShell.tsx:3` 通过 `useLocation`/`useNavigate` 驱动界面。

- **落点由 URL 决定**：`AppShell.tsx:39-40` 从 hash 第一段解析 `active`（非法/空路径回退 `dashboard`）；空路径重定向 `/dashboard`（`navigateTo` 内的 `navigate("/dashboard", { replace: true })`，`AppShell.tsx:53`）。
- **深链可用**：刷新、浏览器后退/前进、直接输入 `#/business/inventory` 均可定位到具体页面与子 Tab；业务中心支持 `/business/inventory` 深链库存中心。
- **零服务端改造**：采用 hash 模式（非 BrowserRouter），无需 Nginx history fallback；E2E 的 `page.goto("/")` 仍可用。

> 注意：V1.0 文档中的页面路径现在**真实存在**（以 hash 形式），本章后续仍用**页面键**指代一级导航，子页用 `key/tab` 二级路径。

### 2.2 一级入口

`app/navigation.ts:4-11` 定义 6 项，与 V1.0 一致：

| 页面键 | 名称 | 承载页面组件 | 加载方式 |
|---|---|---|---|
| `dashboard` | 工作台 | `DashboardPage` | 同步（首屏） |
| `business` | 业务中心 | `OrdersPage` | `React.lazy` |
| `customers` | 客户中心 | `CustomersPage` | `React.lazy` |
| `funds` | 资金中心 | `FundsPage` | `React.lazy` |
| `operations` | 经营中心 | `ReportsPage` | `React.lazy` |
| `settings` | 设置 | `SettingsPage` | `React.lazy` |

懒加载页面统一挂 `Suspense`（`AppShell.tsx:210` 路由渲染块），降级文案「正在打开…」。页面以 keep-alive 插槽渲染（见 2.5），访问过的页面常驻挂载，仅非激活态隐藏。

### 2.3 顶栏（AppShell 顶栏区，`AppShell.tsx` 约 110–185）

| 元素 | 行为 |
|---|---|
| 页名 H1 | 取当前导航 label，是页面唯一 H1 |
| 主题切换 | 三态分段控件：系统 / 浅色 / 深色，带 `aria-pressed` |
| 用户中心 | 打开 Modal 挂载 `UserCenterPage`（改密码、查看角色权限），不占侧栏与路由 |
| 当前角色 | **只读展示**。生产态取登录账号角色，开发态取 `X-Dev-User`；角色由管理员配置，不可自行切换 |
| 退出登录 | 退出后落登录页 |

### 2.4 快捷键与移动端

- **⌘/Ctrl + K**：直达业务中心库存 Tab（`AppShell.tsx:72-80` 的快捷键监听 + `navigateTo("business","inventory")`）。
- **窄屏「管理」入口**：侧栏底部按钮 → Modal，仅含经营中心、设置、用户中心（`AppShell.tsx:255-265` 的列表项 `navigateTo`）。
- 侧栏滚动做 iOS 26 边缘渐隐：按滚动位置写入 `--edge-top/--edge-bottom`（AppShell 侧栏滚动逻辑）。

### 2.5 页面切换转场与状态保留

`AppShell.tsx:206-234` 的路由渲染块采用 **keep-alive**：访问过的页面持续挂载，仅非激活态 `display:none`（并加 `aria-hidden`，从 a11y 树排除）。因此切走再回到同一页面，**筛选、分页、当前子 Tab、滚动位置全部保留**——这是路由批次对原 P0-2 的修复。

转场弹簧入场仍由 `.page-enter` 类驱动，但**不再靠 `key={active}` 重挂载**（重挂载会丢状态），而是 `AppShell.tsx:61-68` 用 `pageRef` + 移除/重加 `page-enter` 类的 reflow 技巧重放动画。

### 2.6 权限门控

写操作统一走 `PermissionButton` / `PermissionGate`，读区块走 `PermissionGate`（`shared/ui/PermissionButton.tsx`、`shared/state/session.tsx`）。权限点 26 个，角色映射 5 种（admin / operator / finance / auditor / viewer）。

> **口径**：前端门控只决定**按钮显隐**，不构成权限控制；后端每个写接口二次鉴权。

---

## 3. 工作台（`app/DashboardPage.tsx`）

纯动作入口，不复制经营数据。

| 区域 | 内容 |
|---|---|
| 页头 | 「今天从这里开始」 |
| 售出 | 卡片「售出库存账号」→ 跳业务中心并定位到库存中心 |
| 自营 | 卡片「自营·回收」→ 直接开建单弹窗（HS） |
| 分销 | 卡片「提号」（TH）、「代挂」（DG） |
| 增值服务 | 卡片「代分期服务」（DFQ） |
| 今日关注 | 进行中业务数、已完成业务数（前端按 `orders` 状态统计） |

四组入口整体由 `PermissionGate permission="order.create"` 门控（`DashboardPage.tsx:36`）。金额类总览不在此页——V1.0 设想的「今日收入支出、押金、DFQ 逾期、待审核」**未实现**，改由经营中心 · 数据中心承载。

---

## 4. 业务中心（`orders/OrdersPage.tsx`）

### 4.1 三个 Tab（`OrdersPage.tsx:374-455`）

```text
业务中心
├─ 库存中心       ← 账号台账（可展开）、售出/寄售/下架/返点/编辑/更多
├─ 业务台账       ← 默认 Tab（DEFAULT_BUSINESS_CENTER_TAB = "ledger"）
└─ 分期与回款     ← 合约、收款、逾期回收、换绑交付、退款
```

Tab 栏右侧固定「新建订单⌄」下拉（`order.create`）：新建回收订单 / 新建提号订单 / 新建代挂订单 / 新建代分期订单。

> **入口不一致（待修）**：侧栏点「业务中心」传 `initialTab="inventory"`（`AppShell.tsx:101`）落到**库存中心**；⌘K 与页面自身默认（`businessCenter.ts:6`）落到**业务台账**。同一入口两种落点。

### 4.2 业务台账

- 搜索：订单号 / 游戏账号 / 对方 / 备注。
- 类型筛选（Segmented，带计数）：全部、回收、提号、代挂、代分期。
- 业务筛选（Segmented）：全部业务、自营、分销。
- 状态说明文案：状态由业务流程更新，点击订单后继续处理付款、入库、售出或回款。
- 窄屏自动切 `MobileOrderList` 卡片列表。

### 4.3 库存中心（`accounts/InventoryPanel.tsx`）

账号是库存载体。列表行可展开（`expandRowByClick`），行内操作均 `stopPropagation()`：

| 操作 | 权限 | 可用条件 |
|---|---|---|
| 售出 | `order.create` | 仅 `IN_STOCK` |
| 寄售 | `order.create` | 非 `SOLD` |
| 下架 | `order.event.post` | 非 `SOLD`；当前仅提示「按来源订单执行下架流程」 |
| 返点 | `order.event.post` | — |
| 编辑 | `order.create` | 仅可编辑库存类型 |
| 更多⌄ | `order.create` | 下架 / 取消交易（终止分期并退款）/ 账号描述 / 账号图片 |

顶部有导出按钮（`report.read`），逐条拉明细后合并导出 CSV。

### 4.4 分期与回款（`installments/InstallmentsPanel.tsx`）

统计条：合约数、总应收、已收合计、逾期合约。弹窗四个：

| 弹窗 | 权限 | 说明 |
|---|---|---|
| 分期收款 | `order.event.post` | 必须选择**首付或期次**，填实收金额与日期 |
| 逾期回收 | `order.exception.approve` | 逾期合约处置 |
| 换绑交付 | `order.event.post` | 换绑方式：平台/本方操作、客户自行换绑 |
| 退款登记 | `order.event.post` | 必填取消日期与原因；按合约类型分支提示（提号取消不回库存 / 代分期终止 / 其余账号回库存） |

### 4.5 订单详情（Drawer，`OrdersPage.tsx:456-520`）

**右侧 420px 抽屉**，不是 V1.0 设想的多 Tab 详情页。内容：

1. `Descriptions` 固定字段：业务、类型、增值服务、产品、对方、获客来源、获客负责人、获客时间、金额/进度、最新动作、状态、成交日、备注。
2. 动作记录列表（有 `events` 时出现）。
3. 「更多⌄」下拉（`order.event.post`）：利润分配 / 登记退款 / 取消交易（后两者需 `ACTIVE|COMPLETED`）。
4. 上下文跳转：有 `account_id` 时出「去库存中心」；有分期本金时出「去分期与回款」。

---

## 5. 客户中心（`customers/CustomersPage.tsx`）

三个 Tab（`CustomersPage.tsx:161-167`）：

| Tab | 内容 |
|---|---|
| 客户档案 | 统计（客户总数 / 本月新增 / 今日新增）+ 状态筛选（启用中、已拉黑、已合并）+ 列表；操作：详情、合并、拉黑 |
| 合作方（同行/供货方/平台） | 独立列表；类型：同行、供货方、平台；操作：详情、编辑、拉黑/解除拉黑 |
| 客户需求池 | 需求列表；操作：转单（填订单 ID）、关闭（填原因） |

**客户详情抽屉**：固定资料 → 活字段区（停用字段标注「（已停用）」）→ 经营概览统计（关联订单、进行中、已完成、分期已收、分期应收、剩余应收、逾期期数）→ 关联订单表 → 分期收款表。

**合并**：目标客户必须 `ACTIVE`，必填合并原因（`customer.merge`）。

> **已知缺口**：客户侧只有「拉黑」，**无「解除拉黑」入口**；合作方侧有。客户拉黑在前端实际不可逆。

---

## 6. 资金中心（`pools/FundsPage.tsx`）

六个 Tab（`FundsPage.tsx:565-718`）：

| Tab | 主操作 | 内容 |
|---|---|---|
| 总览 | 资金池划转（`finance.transfer`） | 现金头寸合计 / 可用余额合计 / 押金占用 + 资金池卡片表 |
| 流水 | 新增流水（`deposit.post`） | 6 项筛选（搜索、资金池、方向、状态、起止日期）+ 总收入/总支出/当前结果；行操作：审核、拒绝、冲销 |
| 押金 | 新增占用（`deposit.post`） | 占用列表；行操作：释放、登记损失 |
| 对账 | 新增对账（`deposit.post`） | 对账列表；行操作：核销、查看未达流水（`finance.read`） |
| 异常与月结 | 锁定账期（`deposit.post`） | 单边划转异常表 + 月结锁定表 |
| 返点 | 新增返点记录 / 返点到账（`order.event.post`） | 复用 `RebatesPanel` |

> **与 V1.0 差异**：V1.0 的「划转」是独立 Tab，**实际是总览页右上角的按钮弹窗**；新增了「异常与月结」与「返点」两个 Tab。

---

## 7. 经营中心（`reporting/ReportsPage.tsx`）

顶部独立「报表导出」卡片（不随 Tab 切换）：起止日期 + 多选报表（库存健康、月度损益、提成对账、资金日报、业务损益、资金属性、订单利润）+ 导出（`report.export`），逐项下载 CSV。

十三个 Tab（`ReportsPage.tsx:86-99`）：

| Tab | 内容 |
|---|---|
| 库存 R1 | 在库账号、占用成本 |
| 月度损益 R2 | 销售收入、经营利润 |
| 提成对账 R3 | 订单数、应付、已付、差异 |
| 资金日报 R4 | 现金余额、押金占用、可用余额 |
| 业务损益 R5 | 主营毛利、已结算返点、未归集返点、完整收益 |
| 资金属性分析 | 发生额合计、净方向金额 |
| 订单利润 | 订单级利润明细 |
| 数据中心 | 订单入口卡 + 资金池概览（`finance.read` 门控） |
| 质量中心 | 质量异常工单：新建、关闭、批量关闭（`order.exception.approve`） |
| 系统提醒 | 提醒列表、标记已读；同步返点逾期提醒 |
| 全局搜索 | 跨对象检索 |
| 审计记录 | 只读审计日志 |
| 附件中心 | 附件管理 |

> **与 V1.0 差异**：V1.0 的「异常」Tab 已拆为「质量中心」；另新增资金属性分析、订单利润、数据中心、系统提醒、全局搜索、审计记录、附件中心七个 Tab。
> **性能约定**：隐藏 Tab 不挂载（`ReportsPage.tsx:131-137`），避免首屏并发 13 组请求。

---

## 8. 设置（`field-definitions/SettingsPage.tsx`）

桌面端**左侧竖向 Tab**，≤960px 自动转顶部（`SettingsPage.tsx:52`）。Tab 按权限动态出现：

| Tab | 权限 | 内容 |
|---|---|---|
| 业务字典 | — | 基础字典维护 |
| 业务类型 | `order-type.manage` | 类型启停、影响预览 |
| 资金池 | `pool.manage` | 池维护、启停 |
| 活字段 | `field-definition.manage` | 字段列表、新增/编辑；有历史值只能停用 |
| 游戏类型 | — | 游戏类型维护 |
| 经营规则 | `policy.manage` / `policy.approve` | 规则版本、发布（已发布不可改，只能新建版本） |
| 标准导入 | `import.manage` | 导入批次、映射、对账、提交、回滚 |
| 人员与权限 | `user.manage` | 用户维护、启停 |
| 团队管理 | `user.manage` | 团队维护、启停 |
| 外观 | — | 外观偏好 |

> **与 V1.0 差异**：V1.0 的「历史参考（P2）」实际名为**标准导入**；新增业务字典、游戏类型、团队管理、外观；「人员权限」拆为「人员与权限」+「团队管理」。

---

## 9. 全局交互约束

业务规则沿用 V1.0 第 8 章，并按现状补充：

| 场景 | 要求 |
|---|---|
| 资金影响事件 | 提交前显示池、金额、可用余额变化及库存影响；成功显示事件号和流水号 |
| TH 付同行 | 提示采购支出对资金余额的影响及提号实体不计入自营资产 |
| 分期收款 | HS 分期出售与 DFQ 代分期均必须选择首付或期次，展示应收/已收/本次/剩余；不可超收 |
| DG 混合单 | 录入本金后出现风险标识与审批入口 |
| 返点未归集 | 单独状态标识，标明「未纳入业务收益」 |
| 卖号登记 | 自有库存账号卖出**不新建独立卖出单**，走「库存中心 → 售出」；同行提号卖给买家必须新建 TH 单 |
| 写操作门控 | 一律 `PermissionButton`，前端只管显隐、后端二次鉴权 |
| 加载/失败 | 页面级错误统一 `ErrorBanner`（带 `onRetry`）；Modal 内错误需在 Modal 内部呈现 |
| 键盘可达 | 承载点击的非按钮元素必须有 `role`、`tabIndex` 与 Enter/Space 处理（见 `shared/ui/EntryCard.tsx`） |
| 窄屏降级 | 订单、客户列表提供卡片视图；其余表格依赖 `.ui-table-wrap` 横向滚动 |

---

## 10. 已知交互缺口与待办

本次审查对照源码发现，按优先级排列。**P0 = 影响资金正确性或阻断作业**，建议在下一迭代处理。

### P0

| # | 缺口 | 证据 | 用户实际遇到 |
|---|---|---|---|
| 1 | **无 URL 路由** | `main.tsx:36` 无 `BrowserRouter`；`src` 内 `react-router-dom` 零引用 | 刷新/后退/分享链接一律回工作台，无法定位到具体页面 |
| 2 | **切导航即重挂载，筛选/分页/Tab 全丢** | `AppShell.tsx:178` `key={active}` | 在业务台账设好筛选翻到第 3 页，切走再回来全部重置 |
| 3 | **写操作普遍无 loading、无重复提交保护** | `CreateBusinessModal.tsx:314`、`InventorySaleModal.tsx:163`、`InventoryConsignmentModal.tsx:71`、`InventoryRebateModal.tsx:110`、`InstallmentsPanel.tsx:390/409/439/465`、`FundsPage.tsx:477` 等 | 点提交界面无反应，连点即重复建单 / 重复登记收款 |
| 4 | **Modal 内错误被遮罩挡住** | `InstallmentsPanel.tsx:99` 错误写入页面级 state，但 `ErrorBanner` 在 `:318`；四个 Modal 在 `:368/396/415/445` | 弹窗内提交失败：不关、不提示、错误条在遮罩底下，只能以为卡死。同类：`FundsPage.tsx:563`、`RebatesPanel.tsx:162`、`CustomersPage.tsx:371` |
| 5 | **破坏性操作几乎无二次确认** | 全库 `Popconfirm`/`Modal.confirm` 仅 4 处。一键生效的有：`FundsPage.tsx:477` 流水审核、`PolicySettingsPanel.tsx:232` 规则发布、`PoolsPanel.tsx:72` 停用资金池、`UsersPanel.tsx:56` 停用用户、`CustomersPage.tsx:344` 客户拉黑 | 手滑点错行，一笔错误流水直接进损益；一条未校对规则立即生效 |
| 6 | **金额用裸 `Input` 收，无数字/非负校验** | `FundsPage.tsx:727/753/763/775/818/832`、`InstallmentsPanel.tsx:384`、`RebatesPanel.tsx:242-247`、`InventoryDetail.tsx:163` | 可填 `abc` / `-100` 直接落账 |
| 7 | **无服务端分页，流水硬截断 500 条** | `FundsPage.tsx:100` `cashflowsApi.list({ limit: 500 })` 且无提示 | 流水超过 500 笔时用户会以为只有 500 笔 |
| 8 | **业务中心入口落点不一致** | 侧栏 `AppShell.tsx:101` → 库存中心；默认 `businessCenter.ts:6` → 业务台账 | 同一入口两种落点，肌肉记忆失效 |

### P1

| # | 缺口 | 证据 |
|---|---|---|
| 9 | `DataTable` 的 `page` prop 在非受控模式下被忽略，筛选后翻页越界 | `DataTable.tsx:55,79`；`OrdersPage.tsx:427` 传 `page` 但未传 `controlledPaging`（对照 `InventoryPanel.tsx:496` 正确写法） |
| 10 | 报表/设置 Tab 强制卸载，筛选条件不保留 | `ReportsPage.tsx:134`、`SettingsPage.tsx:57` `children: activeTab === key ? render() : null` |
| 11 | 详情抽屉关闭不刷新列表 | `OrdersPage.tsx:461`、`CustomersPage.tsx:554/920` 仅清 state |
| 12 | 部分 `DataTable` 未传 `loading`，首屏闪空态 | `FundsPage.tsx:588/620`、`CustomersPage.tsx:416`、`InstallmentsPanel.tsx:335`、`RebatesPanel.tsx:184` |
| 13 | 建单弹窗关闭再打开残留上次输入 | `CreateBusinessModal.tsx:310` 仅 `destroyOnHidden`，`resetFields()` 只在成功路径（`:188/:299`） |
| 14 | 校验失败不滚动定位到错误字段 | 全仓 `scrollToFirstError` 零命中；DFQ 最多 120 期，底部报错看不见 |
| 15 | 客户拉黑无解封入口 | `CustomersPage.tsx:340-351` 只有「拉黑」；合作方 `:789` 有 toggle |
| 16 | 押金释放/损失弹窗不显示剩余可释放额与后果 | `FundsPage.tsx:811-838` |
| 17 | `Typography.Link` 承载点击，键盘完全不可达 | `OrdersPage.tsx:57/326/513/518`（含「查看详情」主路径） |
| 18 | 表单有未保存改动时关闭即静默丢弃 | 全仓 `isFieldsTouched`/`isDirty` 零命中 |
| 19 | 多张表未配 `scroll={{x}}`，窄屏列宽挤压 | 仅 `OrdersPage.tsx:436`、`InventoryPanel.tsx:497`、`InventoryDetail.tsx:229` 三处配置 |
| 20 | 批量关闭工单不回显条数、无成功/失败回执 | `QualityPanel.tsx:62-66` |

### 整改进展（截至 2026-10-20）

> 下列 P0/P1 项已在「交互整改」迭代中闭环。原始缺口表（上两节）保留为**发现记录**，本小节为**处置与验证记录**，便于回归时对照。

| 原项 | 状态 | 整改做法与证据 |
|---|---|---|
| P0-3 写操作无 loading / 防重提交 | ✅ 已闭环 | 统一用 `submitting`/`write.pending` + `finally` 复位：`CreateBusinessModal.tsx`、`InventorySaleModal/ConsignmentModal/RebateModal.tsx`、`ImportWorkbench.tsx`、`QualityPanel.tsx`、`AttachmentPanel.tsx`、`ReportsPage.tsx`、`UserCenterPage.tsx`、`CustomerLeadPanel.tsx`；`FundsPage/InstallmentsPanel/RebatesPanel` 本就走 `write.pending`。 |
| P0-4 Modal 内错误被遮罩挡 | ✅ 已闭环 | 新增 `shared/ui/InlineError.tsx` + 扩展 `FormDrawer` 的 `error` prop；`ImportWorkbench` 四个抽屉、`RebatesPanel`、`FundsPage`、写错均改为抽屉/弹窗**内部**展示错误条，不再依赖页面级 `ErrorBanner`。 |
| P0-5 破坏性操作无二次确认 | ✅ 已闭环 | 新增 `shared/ui/ConfirmButton.tsx`（Popconfirm + loading + 防连点 + 权限门）；覆盖 `ImportWorkbench` 确认批次、`PolicySettingsPanel` 发布、`AttachmentPanel` 删除、`CustomersPage` 拉黑/解封、`UsersPanel` 停用、`TeamsPanel`、`PoolsPanel`、`FundsPage` 修复划转等。 |
| P0-6 裸金额 `Input` 无校验 | ✅ 已闭环 | 新增 `shared/lib/validators.ts`（`moneyRules`/`requiredMoneyRules`/`percentRules`）+ `MoneyInput`；`FundsPage`、`InstallmentsPanel`、`RebatesPanel`、`InventoryPanel`、`OrdersPage` 退款、库存三类弹窗、`CustomerLeadPanel` 预算、`AdditionalFeeFields`、`ThFeeSection`、`DfqOrderSection` 全部改为 `MoneyInput` 并挂校验。 |
| P1-15 客户拉黑无解封入口 | ✅ 已闭环 | 桌面端 `CustomersPage:341` 早有 toggle；本轮补齐**手机端** `MobileCustomerList` 第 69 行：由「仅 ACTIVE 可拉黑」改为 `row.status === "ACTIVE" ? "拉黑" : "解除拉黑"` 切换，与合作方手机端 `:93` 一致。 |
| P1-17 `Typography.Link` 键盘不可达 | ✅ 已闭环 | `OrdersPage` 等处的「查看详情／更多」由 `Typography.Link` 改为 `Button`，键盘可达（此前回归测试已覆盖）。 |
| P0-1 无 URL 路由 | ✅ 已闭环（路由批次 2026-10-20，`60a08ff`） | `main.tsx` 接入 `HashRouter`；`AppShell` 落点改由 `useLocation/useNavigate` 驱动，深链/刷新/前进后退可用；空路径重定向 `/dashboard`；业务中心支持 `/business/inventory` 深链子页。 |
| P0-2 切导航重挂载丢状态 | ✅ 已闭环（路由批次 2026-10-20，`60a08ff`） | 移除 `key={active}` 重挂载，改为 keep-alive：访问过的页面常驻挂载、非激活态 `display:none`（+`aria-hidden`），筛选/分页/子 Tab/滚动位置切走再回保留；转场弹簧入场用 `pageRef`+reflow 重放 `.page-enter`，不再靠重挂载。 |
| P0-8 业务中心入口落点不一致 | ✅ 已闭环（路由批次 2026-10-20，`60a08ff`） | 落点统一由 URL 决定；侧栏/⌘K/数据中心入口均落 `/business/inventory`（库存中心），与 `businessCenter.ts` 默认台账的差异通过入口显式传 tab 消解；切导航不再重置子 Tab（keep-alive 保留上次所在子页）。 |
| P0-7 流水服务端分页 + 移除 500 硬截断 | ✅ 已闭环（批次二 2026-10-20） | 后端 `/cashflows` 改返回 `CashflowListOut{items, total}`，支持 `occurred_from`/`occurred_to` 服务端日期过滤 + `limit`/`offset` 分页（上限 2000），`total` 为命中总数；前端 `FundsPage` 移除 `limit:500` 硬截断，日期区间改为服务端传参（`fetchCashflows` 用 ref 持有当前值，全局 `load()` 刷新仍套用当前区间），表格保留客户端关键词/资金池/方向/状态筛选与 `DataTable` 客户端分页；原「仅加载最近 500 条」警告改为「共 Y 笔 / 已加载 X 笔」提示，超上限才警示；`transferAnomalies` 单边划转与「未达流水」钻取仍基于完整已加载集合，对账/导出数据完整性保留。 |

**仍开放（架构级/大改动）：** P1-9/10/11/12/13/14/16/18/19/20（多为筛选/分页保留、滚动定位、未保存提示、窄屏列宽、批量回执等体验打磨）。

### 正面基线（回归时不得破坏）

- `EntryCard.tsx:21-32`：`div` 承载点击的合规实现（`role="button"` + `tabIndex=0` + Enter/Space），且有键盘回归测试。
- `InventoryPanel.tsx`：`exporting`/`savingAccount`/`executionLoading` 逐态 loading + 成功后刷新失败的降级提示（`:380-388`），是全仓最完整的写反馈样板。
- `FieldsPanel.tsx:126-140`：唯一带对象名与前置规则的 `Popconfirm`（「无历史值才可删除；已有历史值只能停用」），是确认文案的样板。
- `OrdersPage.tsx:529/556/621`：取消/分配/退款三个弹窗全接 `confirmLoading`。
- `ImportWorkbench.tsx:152-166`：`act()` 统一 loading + `finally` 复位 + 失败不关抽屉。
- `InventoryPanel.tsx:503` 起：行展开与 6 个行内按钮全部 `stopPropagation()`，是全仓唯一无冲突的表格。

---

## 11. 页面验收

| 验收重点 | 页面 |
|---|---|
| 资金池收入、支出、押金、可用余额清晰 | 资金中心总览、经营中心 R4、经营中心 · 数据中心 |
| 四类业务按正确资金和库存规则流转 | 业务中心业务台账/订单详情抽屉/库存中心/分期与回款 |
| 客户可跨业务追溯，且不把合作同行混为客户 | 客户中心客户档案、合作方 Tab |
| 直接成本、两类分期合约、返点记录可追溯 | 业务中心库存/分期与回款、经营中心 R2/R5、资金中心返点 |
| 规则影响未来、快照保护过去 | 设置经营规则、订单详情利润分配、经营中心 R3/R5 |
| 写操作有 loading、失败可恢复、输入不丢 | 全部写路径（见第 10 章 P0-3、P0-4） |
| 键盘可达、窄屏可用 | 订单详情「查看详情」、全部表格（见第 10 章 P0-6、P1-17、P1-19） |
