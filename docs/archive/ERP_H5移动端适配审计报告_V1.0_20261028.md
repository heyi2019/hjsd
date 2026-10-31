# ERP_H5移动端适配审计报告_V1.0

| 项 | 内容 |
|---|---|
| 文件编号 | ERP_H5移动端适配审计报告_V1.0 |
| 阅读对象 | 何一 / 前端开发 |
| 编写日期 | 2026-10-28 |
| 编写人 | WorkBuddy |
| 审计方式 | 真实浏览器（Chromium）+ 375×812 视口逐路由实测（scrollWidth / 元素越界测量 + 截图取证），非静态推断 |

## 一、总体结论

**页面级未破版，但内层表格大面积未适配。** 全部 8 个路由的 `document.scrollWidth` 均为 375（无横向破版、无整页平移），外壳层（底部导航、卡片堆叠、筛选器折行、弹窗）适配良好；问题集中在**数据表格横向超宽**与**个别并排控件溢出**。

现有适配覆盖面（`shared/styles/responsive.css`）：仅 **业务台账（orders-ledger）** 与 **客户档案（customer-table）** 两处做了移动端处理，其余页面表格均为"原始宽度 + 外层滚动"。

## 二、逐路由实测数据（视口 375px）

| 路由 | 页面级溢出 | 主要越界内容 | 实测宽度 | 结论 |
|---|---|---|---|---|
| `#/dashboard` | 无 | 无 | — | ✅ 良好 |
| `#/business/inventory` | 无 | 库存明细表 | **1161px**（越界 815px） | ⚠️ P0 |
| `#/business/ledger` | 无 | 台账表（已有移动卡片，隐藏后残留测量值同上） | — | ✅ 已适配 |
| `#/business/collections` | 无 | 分期与回款表 | 1161px 同源 | ⚠️ P0 |
| `#/customers` | 无 | 仅 Tab 栏可滑动（antd 自带） | — | ✅ 已适配 |
| `#/funds` · 总览 | 无 | 资金池表 | 964px（越界 618px） | ⚠️ P1 |
| `#/funds` · 流水 | 无 | **资金明细表** | **2362px**（越界约 2000px，152 个元素越界） | 🔴 最重灾区 |
| `#/operations` | 无 | 报表导出日期区间溢出 + 报表表 818px | — | ⚠️ P1（导出控件 P0 观感） |
| `#/settings` | 无 | 仅 19 个 Tab 横滑 | — | ✅ 可接受 |

## 三、问题清单

### P0 — 接近不可用

1. **资金中心 · 流水表（2362px）**
   - 视口 375px，需横向滚动约 2000px；操作列（**冲销** 按钮）位于最右端，单次操作需滚动到表尾。
   - 152 个叶子元素越界，最远元素 `right=2391px`。
   - 见 `h5_audit_20261028/mob_funds_flows.png`。

2. **业务中心 · 库存明细表 / 分期回款表（1161px）**
   - 台账已有移动卡片方案，库存与分期两个子页没有，体验割裂。
   - 见 `h5_audit_20261028/mob_inv.png`。

3. **经营中心 · 报表导出日期区间**
   - 两个日期框并排，第二个被视口裁掉一半（截图 `mob_ops.png` 可见「至 年/月/日」右侧截断）。

### P1 — 可用但体验差

4. **滚动发生在 `.page-content` 层而非表格容器**：实测 `.ant-table-body` 的 `scrollWidth === clientWidth`（不裁剪），溢出被 `.page-content { overflow-x: auto }` 兜住——表现为"整页内容左右平移"而非"表头固定、表体滚动"。
5. **资金中心总览表 964px、经营中心各报表表 680–818px**：可滚但列多，无操作列常驻。
6. **Tab 栏溢出**：资金 7 / 经营 13 / 设置 19 个 Tab 靠 antd 横向滑动，功能可用，发现性一般（建议本期不动）。

### 已适配良好（无需改动）

- 底部导航栏（60px + safe-area）、`···` 更多入口
- 工作台入口卡片、dashboard 单列堆叠
- 筛选器/搜索框全宽折行
- 弹窗：新建回收订单 15 个字段全宽自适应 + 底部主按钮常驻（`mob_modal2.png`）
- 客户档案移动卡片、台账移动卡片

## 四、修复建议（供裁决，本次未动代码）

### 批次 1（低风险全局兜底，只动 `responsive.css` / 少量样式）

1. **表格滚动容器归位**：给 `.ant-table-wrapper` 形成真实滚动容器（当前 `overflow-x:auto` 规则未生效于 body 结构），使滚动发生在表体而非 page-content；配合 `.ant-table` 设 `min-width` 阈值。
2. **操作列 sticky**：对含操作列的表加 `position: sticky; right: 0`（优先流水表、库存表），关键动作常驻可见。
3. **日期区间纵向堆叠**：640px 以下报表导出的 RangePicker 区块改 `flex-direction: column`。

### 批次 2（较大，逐页验证）

4. 流水表移动端瘦身（隐藏备注/流水号等次要列）或参照台账做移动卡片。
5. 库存、分期表参照 `orders-mobile-card` 模式卡片化。
6. （可选）资金/经营 Tab 移动端收纳为「更多」面板。

### 风险提示

- `responsive.css` 为全站共享样式，改动会影响所有已适配页面（台账、客户档案），需回归 `erp-frontend-browser-verify` 流程 + 相关 vitest。
- 操作列 sticky 与 antd `fix-right` 列可能冲突（现有台账已用 `position: static !important` 反制 fixed 列），需统一策略。

## 六、批次 1 实施结果（2026-10-28 完成，已验证）

改动文件：
- `frontend/src/shared/styles/responsive.css`（640px 断点块）
- `frontend/src/reporting/ReportsPage.tsx`（导出日期区间 Space 加类名 `ui-filter-bar__range`）

### 6.1 表格滚动容器归位（根因修复）

原规则 `.ant-table-wrapper .ant-table { min-width: 680px }` 有两个问题：窄表被撑宽白受一次横滚；滚动发生在 wrapper 层。改为：

```css
.ant-table-wrapper .ant-table { width: 100%; min-width: 0; }
.ant-table-wrapper table { width: max-content; min-width: 100%; }
.ui-table-wrap .ant-table-content { overflow-x: auto; }
```

**关键坑（实测踩到，务必记住）**：`.ant-table-content` 自带 `overflow-x: auto`，是 sticky 的参照系。把滚动口放在 `.ant-table-wrapper` 时，粘性列会随表一起滑走（实测 `scrollLeft=900` 后首列 `left=-871`）。滚动口必须落在 `.ant-table-content` 层，sticky 才生效。

修复后实测：`scrollLeft=900` 时首列 `left=29 = content left`，**常驻成立**。

### 6.2 首列常驻（行标识不丢失）

```css
.ant-table-tbody > tr > td:first-child,
.ant-table-thead > tr > th:first-child {
  position: sticky; inset-inline-start: 0; z-index: 2;
  background: linear-gradient(var(--glass), var(--glass)), var(--color-bg);
}
```

背景用双层写法：玻璃层压实底上。单写 `--glass`（alpha 0.62）会透出滚过去的内容。

### 6.3 报表导出日期区间堆叠

`.ui-filter-bar__range` 在 640px 以下改两行栅格（起始日期独占一行 / 「至 + 结束日期」同行），原生 date 输入 `width: 100%`。修复前最远越界元素为日期框，修复后经营中心非表格越界元素归零。

### 6.4 验证结果

| 验证项 | 结果 |
|---|---|
| 页面级横向溢出（8 路由） | `scrollWidth = 375` 全部无破版 |
| 首列 sticky | sticky 生效，横滚 900px 后仍停左沿（此前会滑走） |
| 单/双层滚动 | 归位 `.ant-table-content`，不再整页平移 |
| 窄适配表免横滚 | settings / customers 表格零滚动需求（此前强制 680px 必滚） |
| 日期区间溢出 | 归零 |
| 针对性测试 | ReportsPage / InventoryPanel / OrdersPage / CustomersPage 共 4 文件 **42 用例全过** |
| ui_guards（13 条） / tsc / vite build | 全绿 |

### 6.5 遗留（批次 2）

- 资金中心·流水表 2362px、库存/分期表 1161px 仍需大幅横滚 → 建议移动端卡片化（参照 `orders-mobile-card`）或隐藏次要列。
- Tab 栏溢出依赖 antd 原生横滑，未改（可接受）。
- `.main` 的 `scrollWidth=445` 为顶栏装饰层溢出，`body` 的 `overflow-x: hidden` 已兜住，无可见破损。

## 七、批次 2 实施结果（三张超宽表瘦身，已验证）

改动文件：
- `frontend/src/pools/FundsPage.tsx`（资金流水列）
- `frontend/src/accounts/InventoryPanel.tsx`（库存列）
- `frontend/src/installments/InstallmentsPanel.tsx`（分期合约列）
- `frontend/src/shared/styles/responsive.css`（新增 `@media (max-width: 767px)` 块）

### 7.1 隐藏清单（业务取舍，可按需微调）

| 表 | 原列数 | 移动端保留 | 隐藏 |
|---|---|---|---|
| 资金流水 | 14 | 订单号 / 日期 / 收支 / 金额 / 状态 / 操作 | 流水号、类别、资金性质、核算属性、流向、来源、审核追溯、备注 |
| 库存明细 | 10 | 展开 / 订单号 / 类型 / 状态 / 成本 / 操作 | 业务、产品、账号标识、平台、未售时长 |
| 分期合约 | 14 | 展开 / 合约号 / 订单 / 总应收 / 已收 / 剩余 / 状态 / 操作 | 业务、类型、产品、对方、服务费、每期服务费、坏账 |

### 7.2 实现方式（踩了三个坑，都记在 CSS 注释里）

1. **必须 className + onCell 双写**：antd 的 `column.className` 只作用于表头 `th`，表体 `td` 拿不到。只写一处理会出现「表头隐藏、表体不隐藏」的**列错位**（实测 th=6 / td=14）。
2. **不能用 antd 的 `responsive` 属性**：jsdom 无 breakpoint，`Grid.useBreakpoint()` 全为 false，antd 会把列整个过滤掉，批量单测失败（实测 9 例，改 CSS 后恢复）。曾尝试把测试桩 `matchMedia` 改成按 `innerWidth` 判定，可行但属全局测试基建改动，影响面大，最终放弃、退回 CSS 方案。
3. **rc-table 的 `measure-row` 与 `<col>` 内联宽度会残留**：隐藏列的格子已 `display:none`，但 measure-row 仍按原列数占位（实测每列 ~42px，8 列约 336px 虚高），`<col style="width:190px">` 也照样占宽 → 需 `.ant-table-measure-row{display:none}` + `.ant-table col[style]{width:auto!important}`。
4. **`width: max-content` 会让按钮换行彻底失效**：DataTable 传 `scroll.x="max-content"`，rc-table 在 `<table>` 上写死内联宽度，必须 `width:auto!important` 覆盖；同时给 `.ant-table-tbody .ant-space{flex-wrap:wrap}`，操作列由 516px 降到 146px。

### 7.3 实测结果（375×812）

| 表 | 改前表宽 | 改后表宽 | 还需横滚 |
|---|---|---|---|
| 资金流水 | 2362px | **538px** | 221px（约 0.7 屏） |
| 库存明细 | 1161px | **472px** | 155px |
| 分期合约 | 未实测基线（约 1400+） | **809px** | 492px |

- 表头/表体列数一致（6/6、6/6、8/8），**无错位**；首列 sticky 仍生效。
- **桌面端 1280px 零回归**：资金流水 14 列全部可见（hidden=0）、Space 恢复 nowrap、measure-row 正常渲染。
- 针对性测试：pools / accounts / installments / orders / customers / app / reporting 共 **41 文件 335 用例全过**；ui_guards 13 条、tsc、vite build 全绿。

### 7.4 遗留

- 分期合约操作按钮多（6 个），换行后仍有 492px 余量；如需进一步压缩，建议把低频动作收进「更多」下拉（属交互改造，需业务确认）。
- 其余报表（经营中心月度损益 818px 等）未做列隐藏，如需可复用同一套 `ui-col-md-up` 标记。

## 八、批次 3 实施结果（收口剩余溢出，已验证）

批次 2 之后全路由复测，仍有三处真实溢出（`documentElement.scrollWidth` 全为 0，说明不是页面破版，而是控件自身越界）：

| 位置 | 改前 | 根因 | 处置 |
|---|---|---|---|
| 资金中心·总览「资金池卡片」表 | need **639px** | 7 列（资金池/归属/状态/收入/支出/押金/可用余额）全展开；「资金池」列因 `.ant-table` 全局 `white-space: nowrap` 按 max-content 占 **328px** | 隐藏 归属 / 状态 / 押金（保留 资金池 / 收入 / 支出 / 可用余额）；资金池列打 `ui-col-wrap` 放开换行并设 120px 下限 → need **157px** |
| 经营中心·库存健康表（R1） | need **478px** | 7 列全展开 | 隐藏 附加成本 / 占用成本 / 持有天数（保留 游戏账号 / 平台 / 状态 / 买入）→ need **35px** |
| 业务中心「类型筛选」Segmented | 越界 **28–30px** | antd Segmented 不像 Tabs 自带横向滚动，选项多时直接顶出父容器并被裁掉 | `.ant-segmented-group { flex-wrap: wrap }` → 两行全见，`flexWrap: wrap`、组高 32→64px |

附带修复：业务台账移动卡片标签被长值挤压折行（「对方/来源」→「对方/来」+「源」）。`.orders-mobile-card__meta dt` 加 `flex: 0 0 auto; white-space: nowrap`，标签固定、值自己折。

**为什么 Segmented 用换行而不是横滚**：Segmented 没有 Tabs 的「…」折叠入口，横滚会把末项切在卡片边缘且没有任何可滚提示，看图像坏版；筛选项通常 ≤6 个，换一行即可全见，信息不丢。

**为什么 `ui-col-wrap` 不做全局**：全局放开 `td { white-space: normal }` 实测会把业务台账移动卡片的「对方/来源」标签一并折行，因此改为按列打标。

### 8.1 验证结果

- 8 路由 `pageScroll` 全部 **0**；`worst` 列表只剩 antd Tabs/Segmented 内部可滚项（属设计行为，非破版）。
- **桌面端 1280px 零回归**：资金池表 7 列全可见（hidden=0）、`white-space: nowrap`、Segmented 单行（组高 32px）。
- 针对性测试：pools / reporting / orders / customers **21 文件 213 用例全过**；ui_guards 13 条（135 文件）、`tsc --noEmit`、`vite build` 全绿。

### 8.2 现状与剩余可选项

- 资金池总览表仍有 157px 横滚（4 列中第 3 列末尾被切）。该表为 4 列财务汇总，3 个金额列各占 110–125px 已无压缩空间；如需完全免滚，只能再隐藏「支出」——属业务取舍，未自行决定。
- 分期合约操作列 6 个按钮仍有 492px 余量，建议低频动作收进「更多」下拉（交互改造）。

## 九、批次 4 实施结果（覆盖全部 46 个内页 Tab，已验证）

批次 1–3 只覆盖到每个路由的**默认 Tab**。用「逐路由点击每个 Tab + 测量」的方式把 8 个路由下全部 **46 个 Tab** 扫了一遍，发现 **22 个 Tab 的表格仍需 200–1219px 横滚**。批次 4 把已验证的 `ui-col-md-up` 机制铺到这些表上，共改动 17 个文件。

### 9.1 隐藏清单（取舍规则沿用批次 2/3：保留 标识/名称 + 日期/账期 + 主金额 + 状态/操作）

| 位置 | 移动端保留 | 隐藏 |
|---|---|---|
| 资金·押金 | 对手方 / 占用金额 / 剩余 / 状态 / 操作 | 来源订单、预计释放、已释放、已损失 |
| 资金·对账 | 资金池 / 对账日期 / 差异 / 状态 / 操作 | 账户、系统余额、账面余额 |
| 资金·返点 | 返点单号 / 对方 / 预计到账 / 状态 / 操作 | 来源订单、业务、类型、产品、基数、费率（另给「对方」加换行） |
| 资金·工作室支出 | 日期 / 科目 / 金额 / 状态 / 操作 | 资金池、收支、备注、审核追溯 |
| 资金·月结账期锁 | 账期 / 锁定时间 / 锁定人 | 说明 |
| 经营·月度损益 R2 | 月份 / 销售收入 / 运营费用 / 经营利润 | 账号直接成本、返点收益 |
| 经营·提成对账 R3 | 人员 ID / 订单号 / 应付 / 差异 | 利润基数、费率、已付 |
| 经营·资金日报 R4 | 资金池 / 收入 / 支出 / 可用余额 | 名称、期初、押金占用、现金余额 |
| 经营·业务损益 R5 | 业务 / 主营收入 / 主营毛利 / 完整收益 | 主营成本、已结算返点、未归集返点 |
| 经营·资金属性分析 | 资金池 / 资金性质 / 发生额 / 净方向金额 | 核算属性、现金方向、笔数 |
| 经营·订单利润 | 订单号 / 成交日 / 状态 / 收入 / 净利 | 业务、直接成本、返点 |
| 经营·数据中心 | 资金池 / 收入 / 支出 / 可用余额（资金池列加换行） | 状态、押金 |
| 经营·质量中心 | 工单号 / 标题 / 状态 / 操作 | 级别、对象、问题 |
| 经营·系统提醒 | 标题 / 内容 / 状态 / 操作 | 提醒编号、对象 |
| 经营·审计记录 | 时间 / 操作人 / 动作 / 原因 | 对象类型、对象编号 |
| 设置·表单字段 | 标签 / 类型 / 必填 / 启用 / 操作 | 字段键、选项 |
| 设置·人员与权限 | 用户名 / 姓名 / 角色 / 状态 / 操作 | 数据范围、团队、资金池 |
| 设置·改动追溯 | 时间 / 操作人 / 动作 / 对象 | 配置项、对象类型、备注 |
| 设置·团队管理 | 团队名称 / 状态 / 操作 | 编码、说明 |
| 设置·资金池定义 | 名称 / 类型 / 状态 / 操作 | 代码、归属 |
| 设置·编号序列 | 编号域 / 前缀 / 当前值 / 下一编号 | 序列键、补齐位数 |
| 设置·导入工作台 | 行号 / 原始内容 / 行状态 / 操作 | 单边划转、补录依据、补录人 |
| 客户·客户需求池 | 客户 / 需求类型 / 预算 / 状态 / 操作 | 需求编号、目标 |

### 9.2 实测结果（375×812，46 个 Tab 全采样）

- **合计需横滚 14509px → 6557px，降 7952px（-54%）**。
- 46 个 Tab 的 `pageScroll` 全部为 **0**（无整页破版）。
- 改善幅度最大的：返点 1219→411、质量中心 902→175、工作室支出 731→109、对账 762→261、表单字段 937→402、人员与权限 880→313、月结账期锁 441→0、团队管理 348→0。
- **桌面 1280px 零回归**：资金·对账 8 列、设置·人员与权限 8 列全部可见（hidden=0）。

### 9.3 两个方法上的教训

1. **首轮扫描会把「数据未加载」误读为 0**。资金日报 R4、月度损益 R2、提成对账 R3、编号序列在首轮读数为 0，复测才暴露真实溢出 707 / 302 / 211 / 298px。判定「某 Tab 已适配」前必须确认表格有数据行。
2. **同文件的多处列隐藏必须一次成批、自底向上插入**。分批改会插入行导致后续行号漂移，第二批会定位到错误的列。

### 9.4 验证与遗留

- 针对性测试：pools / rebates / reporting / quality / notifications / audit / field-definitions / users / customers / imports **40 文件 261 用例**，260 通过、1 失败。
- 唯一失败 `CustomersPage.write.test.tsx > 客户列表支持关键词搜索并把条件传给后端`：**已隔离验证为既存失败**——还原本次对 `CustomerLeadPanel.tsx` 的改动后仍然复现，与批次 4 无关（该文件的 `CustomersPage.tsx` 属并行会话改动范围）。
- ui_guards 13 条（135 文件）、`tsc --noEmit`、`vite build` 全绿。

**遗留（均需业务裁决，未自行决定）**
- 业务中心·分期与回款 **492px**：操作列有 6 个按钮，换行也已到极限；需把低频动作收进「更多」下拉（交互改造）。
- 资金·返点 411px、设置·表单字段 402px、设置·人员与权限 313px：再压就要删掉上表已保留的核心列。

## 五、证据文件

| 文件 | 内容 |
|---|---|
| `h5_audit_20261028/mob_inv.png` | 业务中心·库存中心 375px |
| `h5_audit_20261028/mob_funds.png` | 资金中心·总览 375px |
| `h5_audit_20261028/mob_funds_flows.png` | 资金中心·流水（最重灾区） |
| `h5_audit_20261028/mob_ops.png` | 经营中心（日期区间截断可见） |
| `h5_audit_20261028/mob_set.png` | 设置页 375px |
| `h5_audit_20261028/mob_modal2.png` | 新建回收订单弹窗（适配良好对照） |
