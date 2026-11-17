/** 测试分层单一事实源：vitest.config.ts、test-full-sharded.mjs、manifest-parity.test.ts 共同引用，
 *  避免多处各写一份清单后漂移（2026-10-27 实锤：脚本硬编码清单落后 44 个新文件，
 *  「未分片」守卫直接 exit 1，test:full 长期不可用，大家被迫退回 404s 串行全量）。
 *
 *  路径基准 = **仓库根**（2026-11-04 起前端测试迁到 tests/frontend/，不再以 frontend/ 为基准）。
 *  与 vitest root、test-full-sharded 的收集前缀、manifest-parity 的期望计数同一基准；
 *  漏改任一处，文件会「既不在 fast 也不在 react」= 静默不跑。
 *
 *  分层口径：unit/ = 纯逻辑（不挂载 React 组件）；module/ = 组件与页面（需要 jsdom 渲染）。
 *  区域目录：system / workbench / business / customer / finance / operations / settings / shared
 */

// 纯逻辑 + 静态守卫：无 jsdom 渲染、无网络，秒级。
export const fastTests = [
  // 测试基建自测（夹具种子与浏览器状态复位）
  "tests/frontend/unit/system/fixtures.test.ts",
  // vi.mock 模块标识守卫：纯静态扫描（无 DOM、无网络），放快速档以便每次提交即跑。
  "tests/frontend/unit/system/mock-specifier.test.ts",
  // 结构一致性守卫（TESTING-06）：扫盘 + 读 manifest，纯静态，与 mock 守卫同理放快速档。
  "tests/frontend/unit/system/manifest-parity.test.ts",
  // 构建/测试配置守卫（别名、define、project 结构）
  "tests/frontend/unit/system/vite.config.test.ts",
  // 全量回归层调度守卫：确认轻量层并行且保留失败结果。
  "tests/frontend/unit/system/test-full-sharded-scheduling.test.ts",
  // 业务纯逻辑
  "tests/frontend/unit/business/inventory-export.test.ts",
  "tests/frontend/unit/business/inventory-logic.test.ts",
  "tests/frontend/unit/business/orderpage-helpers.test.ts",
  // 共享层 API 客户端与工具函数
  "tests/frontend/unit/shared/catalog.orders.test.ts",
  "tests/frontend/unit/shared/catalog.test.ts",
  "tests/frontend/unit/shared/client.cache.test.ts",
  "tests/frontend/unit/shared/client.test.ts",
  "tests/frontend/unit/shared/financeApiBoundaries.test.ts",
  "tests/frontend/unit/shared/format.test.ts",
  "tests/frontend/unit/shared/listColumns.test.ts",
  "tests/frontend/unit/shared/money.test.ts",
  "tests/frontend/unit/shared/retiredProducts.test.ts",
];

// 日常反馈层：覆盖登录、权限、主工作台、订单写路径、报表和设置等关键面，
// 不包含库存/客户/资金等长链路全量页面回归。
export const quickTests = [
  "tests/frontend/module/workbench/DashboardPage.test.tsx",
  "tests/frontend/module/system/LoginPage.test.tsx",
  "tests/frontend/module/system/UserCenterPage.test.tsx",
  "tests/frontend/module/settings/SettingsPage.test.tsx",
  "tests/frontend/module/business/CreateBusinessModal.test.tsx",
  "tests/frontend/module/settings/PolicySettingsPanel.test.tsx",
  "tests/frontend/module/operations/ReportsPage.test.tsx",
  "tests/frontend/module/shared/session.test.tsx",
];

/** 把 vitest include 风格的 glob（仅用到 * 与 **）转成正则。`*` 不跨目录段。 */
export const globToRegExp = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
};

export const matchesAny = (file, patterns) => patterns.some((pattern) => globToRegExp(pattern).test(file));
