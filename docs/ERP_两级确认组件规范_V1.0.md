# ERP 两级确认组件规范 V1.0

> 文件编号：ERP_两级确认组件规范_V1.0
> 运行域：前端 · 通用能力
> 阅读对象：前端开发、测试、代码评审
> 编写日期：2026-11-02
> 编写人：Aries OS（何一）

## 1. 背景与目的

此前全站 antd `Popconfirm` 仅 4 处，而流水审核、规则发布、停用资金池 / 业务类型 / 用户、客户拉黑等
不可逆操作多为**一键生效**——误点即落库且不可撤销。同时 `appModal.confirm` 散落在业务代码里，
确认框的文案、危险样式、失败反馈、提交防重缺乏统一契约。

本规范把「确认 + 反馈 + 防重 + 权限」收口为**两级确认组件**，所有破坏性 / 丢弃类操作统一走此标准，
调用方只需声明「做什么（title）」与「影响什么 / 能否撤销（description）」，不再各写一套确认弹层。

## 2. 两级确认的适用边界

| 级别 | 组件 | 底层 | 适用场景 | 遮罩 | Esc | 典型用例 |
| --- | --- | --- | --- | --- | --- | --- |
| **Popover 级** | `ConfirmButton` | antd `Popconfirm` | 可逆 / 简单销毁的单键操作；确认后无需额外输入 | 无 | 点外部 / 取消即关 | 行内一键删除、停用、拉黑、删除选项 |
| **Modal 级** | `ConfirmDialog` | antd `Modal` | 需多输入（表单），或丢弃未保存内容等较重确认 | 有 | 可关闭（keyboard） | 建单放弃、复购确认、客户合并 |

**选型原则**：
- 操作**轻量、可逆、单键** → `ConfirmButton`（Popover 级），不打断页面上下文。
- 操作**较重**（要填东西 / 会丢未保存内容 / 多步确认）→ `ConfirmDialog`（Modal 级），用遮罩聚焦注意力。

## 3. 行为契约（两级对齐）

两级组件共享以下契约，确保用户体验一致：

1. **提交防重**：pending 期间禁用取消、防重触发；确认按钮显示 `loading`。
2. **失败反馈**：失败统一走全局 toast（`appMessage.error`），组件自身不带页面级错误位——
   行内一键操作没有 Modal 容器可放内联错误，否则用户看到「点了没反应」。
3. **受控关闭**：`ConfirmDialog` 由父级用 `open` 受控，成功 / 失败后**均交由父级决定是否关闭**；
   组件不在成功时自动关。
4. **入场动画**：默认带 `.heijin-fast-confirm`（二次确认框 50ms 入场，见 antd-adapter.css）。
5. **默认文案**：`okText` 默认「确认」，`cancelText` 默认「取消」；Modal 级可显式覆盖。

## 4. 按钮文案规范

- **确认键 = 动作动词**，让用户明确点击后发生什么，禁止模糊的「确定」：
  - 删除类 → `删除`；停用类 → `停用`；退出类 → `退出` / `退出登录`；
  - 丢弃类 → `放弃`；合并类 → `确认合并`。
- **取消键**统一为 `取消`（或语义明确的「继续编辑」「返回修改」等），保持「点了不做事」的直觉。
- `ConfirmButton` 已原生支持 `cancelText`（默认「取消」），调用方无需重复传「取消」。

## 5. 危险操作样式

- `danger` 控制**确认按钮**红色；**仅当操作不可逆 / 有损**时标 `danger`
  （删除、停用、放弃、退出、合并等均属此类）。
- 取消键永不着红——红色只出现在「执行破坏」的那一下。

## 6. Esc 与遮罩规则

- **Modal 级**：`keyboard`（Esc 可关闭）开启、`maskClosable={false}`（点击遮罩不关闭，防误关丢内容）。
- **Popover 级**：无遮罩，点外部或取消即关。
- 页面级浮层（如 `ResizableModal` / `BusinessActionModal`）的 Esc 拦截由各浮层自行负责，不在两级确认组件内重复处理。

## 7. 权限门控

- `ConfirmButton` 的 `permission` **可选**：需权限的操作（删除字段、删除选项等）传 `permission`，
  由 `PermissionGate` 门控；无需权限的操作（退出登录等）省略 `permission`，组件直接渲染触发按钮。
- `ConfirmDialog` 不做权限门控——权限由触发它的页面 / 按钮在调用前把关，避免双重拦截。

## 8. 测试约定（重要）

测试环境用 `rc-motion` 桩（`src/test/motion-stub.tsx`）替代动画。该桩必须遵守 rc-motion 的
`visible === false && removeOnLeave` 语义——此时**不渲染** children。历史上该桩硬编码
`visible: true`，使 antd `Button`（无自定义图标者）**总是渲染 loading 图标**（`aria-label="loading"`），
把按钮可访问名污染为「loading 删除」，导致 `getByRole("button", { name })` 精确匹配失效。
**根因已修**（L1805 收口后一轮），现按措辞精确断言即可。

- 涉及 `ConfirmButton` / `ConfirmDialog` 按钮的断言**优先用可访问名精确匹配**
  （`within(dialog).getByRole("button", { name: "删除" })`）：一旦 loading 图标再次出现（例如桩被
  改回硬编码 `visible: true`），断言会立即失败，起到回归护栏作用。
- 仅当同一文案在多个位置出现、需要缩小范围时，才退回 `within(...).getByText(...)`；**不要**用
  `/正则/` 去「绕过」可访问名不匹配——那是掩盖污染，而非修复。

## 9. 本次 B 方案迁移清单（L1805）

- 新建 `ConfirmDialog`（Modal 级共享组件），并把全站确认收口到 `ConfirmButton` 与 `ConfirmDialog` 两个组件。
- 5 处裸 `Popconfirm` → `ConfirmButton`：`AppShell` 顶栏退出、`UserCenterPage` 退出、
  `IntermediaryPlatformSettingsPanel` 删除选项、`GameTypeSettingsPanel` 删除游戏类型、
  `useOrderFormFieldsPanelController` 删除字段。
- 建单 2 处 `appModal.confirm` → `ConfirmDialog`：`CreateBusinessModal` 复购确认、放弃确认。
- 客户合并确认按钮补 `danger`，对齐 Modal 级危险确认规范。
- 该轮闭环的验收结论已并入本节清单；原始交互测试报告（含 P1 修复版）已于 2026-11-11 清退，需要时从 git 历史追溯。
