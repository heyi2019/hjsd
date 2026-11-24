import { navItem } from "../support/api-stub";
import { expect, test } from "@playwright/test";

/**
 * 降级验证：主动中断 API 请求，验证后端不可达时页面显示错误且外壳不白屏。
 *
 * 前端对 API 失败的处理是落到 ErrorBanner / .ant-alert（已由组件测试覆盖），
 * 而非抛 React render error。测试通过开发态会话进入页面，覆盖断网后的渲染。
 */
test("后端不可达时页面仍渲染外壳、不白屏", async ({ page }) => {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (request) => failed.push(request.url()));
  await page.route("**/api/**", (route) => route.abort("failed"));

  await page.goto("/");

  // 外壳与导航必须可见，证明未白屏。
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(navItem(page, "工作台")).toBeVisible();
  await expect.poll(() => failed.some((url) => new URL(url).pathname.startsWith("/api/")), { timeout: 3000 }).toBe(true);
  await expect(page.getByRole("alert").filter({ hasText: "当期配置读取失败" })).toBeVisible();

  // 允许出现业务层错误提示（.ant-alert），但不允许 React 未捕获崩溃。
  expect(errors).toEqual([]);
});

test("后端不可达：进入资金中心不白屏（列表接口失败降级）", async ({ page }) => {
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (request) => failed.push(request.url()));
  await page.route("**/api/**", (route) => route.abort("failed"));

  await page.goto("/");
  await navItem(page, "资金中心").click();
  await expect(page.locator(".topbar__page")).toHaveText("资金中心");
  await expect.poll(() => failed.some((url) => new URL(url).pathname === "/api/pools"), { timeout: 3000 }).toBe(true);
  await expect(page.getByRole("alert").filter({ hasText: "/api/pools" })).toBeVisible();

  // 主内容区可见：证明即便 pools/funds 接口失败，页面仍挂载而非崩溃。
  await expect(page.locator("main, .app-main, [class*='content']").first()).toBeVisible();
  expect(errors).toEqual([]);
});
