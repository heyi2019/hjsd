import { type Page, type Locator } from "@playwright/test";

/**
 * 统一拦截前端 → 后端 `/api/v1/**` 请求，返回安全 stub。
 *
 * 设计要点（来自组件测试的踩坑经验）：
 *  - 列表类接口（orders / pools / customers / accounts / funds / installments /
 *    rebates / history/batches / history/rows）返回 `{ items: [], total: 0 }`，
 *    让页面走正常空态渲染，而不是因缺字段崩溃。
 *  - 对象类接口（reports / history/reconciliation / policy /
 *    audit）返回 `{ items: [], total: 0, result: {}, data: {} }` 兜底，
 *    避免读深层字段（如 reconciliation.funds.note）时抛 undefined。
 *
 * E2E 不激活会崩的 Tab（如历史迁移的「迁移对账」），所以即便 stub 不完整也不会触发深层字段求值。
 */
const OBJECT_PATHS = [
  "/reports/",
  "/history/reconciliation",
  "/policy",
  "/audit",
];

export async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const url = route.request().url();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const isObject = OBJECT_PATHS.some((p) => path.includes(p));
    const body = isObject
      ? { items: [], total: 0, result: {}, data: {} }
      : { items: [], total: 0 };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

/** 6 个主导航入口标签（与 src/app/navigation.ts 一一对应）。 */
export const NAV_LABELS = [
  "工作台",
  "业务中心",
  "客户中心",
  "资金中心",
  "经营中心",
  "设置",
] as const;

/**
 * 精确匹配某个主导航项。
 *
 * 关键坑：Playwright 的 `hasText` 是**子串**匹配——若导航里存在互为子串的两个标签
 * （如曾经的「工作台」与「异常工作台」），`hasText: "工作台"` 会同时命中两个 .nav-item，
 * 触发 strict mode violation（2 elements）。用 `^label$` 正则锚定做精确匹配。
 */
export function navItem(page: Page, label: string): Locator {
  return page.locator(".nav-item", { hasText: new RegExp(`^${label}$`) });
}
