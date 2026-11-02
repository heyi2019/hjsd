/** 移动端（H5）组件层 —— **已下线，仅作留档**（2026-11-03 裁决）。
 *
 * 状态：本目录已移出 `frontend/src`，不在任何编译、测试、打包链路上。
 * - 不被 `frontend/tsconfig*.json` 收录 → 不参与类型检查；
 * - 不在 `src/**` 下 → 不被 vitest 的 include glob 命中；
 * - 无任何业务代码 import → 不进 vite/rollup 产物（`dist` 内已无 H5 类名与代码）。
 *   各业务页窄屏改为直接渲染 `DataTable`，`responsive.css` 里的 `.orders-ledger /
 *   .customer-table { display: none }` 等 H5 配套规则已一并移除。
 *
 * 恢复方式：把本目录整体移回 `frontend/src/h5/`，再把文件内的
 * `../frontend/src/*` 相对导入改回 `../*`，并在目标页恢复 `useCompactLayout()` 分支。
 *
 * 原设计约定（留档）：这个目录只放「怎么在小屏上摆」，不放取数与业务规则；
 * 派生值（金额合计、库龄天数）一律用后端返回字段，不在这一层重算。
 */
export * from "./customers";
export * from "./installments";
export * from "./orders";
export * from "./pools";
export * from "./reporting";
export * from "./stocks";
