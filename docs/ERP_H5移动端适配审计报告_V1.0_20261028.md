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

## 五、证据文件

| 文件 | 内容 |
|---|---|
| `h5_audit_20261028/mob_inv.png` | 业务中心·库存中心 375px |
| `h5_audit_20261028/mob_funds.png` | 资金中心·总览 375px |
| `h5_audit_20261028/mob_funds_flows.png` | 资金中心·流水（最重灾区） |
| `h5_audit_20261028/mob_ops.png` | 经营中心（日期区间截断可见） |
| `h5_audit_20261028/mob_set.png` | 设置页 375px |
| `h5_audit_20261028/mob_modal2.png` | 新建回收订单弹窗（适配良好对照） |
