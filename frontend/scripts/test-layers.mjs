/** 测试分层单一事实源：vitest.config.ts 与 test-full-sharded.mjs 共同引用，
 *  避免两处各写一份清单后漂移（2026-10-27 实锤：脚本硬编码清单落后 44 个新文件，
 *  「未分片」守卫直接 exit 1，test:full 长期不可用，大家被迫退回 404s 串行全量）。 */

// 纯逻辑测试已于 2026-11-04 迁到 `frontend/tests/`（与组件解耦，见 tests/README.md「两个根」）。
// 路径以 **frontend/ 为基准**，与 vitest include、test-full-sharded 的收集前缀同一基准；
// 漏改任一处，文件会「既不在 fast 也不在 react」= 静默不跑。
export const fastTests = [
  "src/test/fixtures.test.ts",
  // vi.mock 模块标识守卫：纯静态扫描（无 DOM、无网络），放快速档以便每次提交即跑。
  "src/test/mock-specifier.test.ts",
  // 结构一致性守卫（TESTING-06）：扫盘 + 读 manifest，纯静态，与 mock 守卫同理放快速档。
  "src/test/manifest-parity.test.ts",
  "tests/stocks/inventory-export.test.ts",
  "tests/stocks/inventory-logic.test.ts",
  "tests/shared/api/*.test.ts",
  "tests/shared/lib/*.test.ts",
  "src/vite.config.test.ts",
];

// 日常反馈层：覆盖登录、权限、主工作台、订单写路径、报表和设置等关键面，
// 不包含库存/客户/资金等长链路全量页面回归。
export const quickTests = [
  "src/app/DashboardPage.test.tsx",
  "src/auth/LoginPage.test.tsx",
  "src/auth/UserCenterPage.test.tsx",
  "src/field-definitions/SettingsPage.test.tsx",
  "src/orders/CreateBusinessModal.test.tsx",
  "src/policy/PolicySettingsPanel.test.tsx",
  "src/reporting/ReportsPage.test.tsx",
  "src/shared/state/session.test.tsx",
];

/** 把 vitest include 风格的 glob（仅用到 * 与 **）转成正则。`*` 不跨目录段。 */
export const globToRegExp = (pattern) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
};

export const matchesAny = (file, patterns) => patterns.some((pattern) => globToRegExp(pattern).test(file));
