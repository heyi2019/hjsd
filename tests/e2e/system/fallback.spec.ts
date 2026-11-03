import { navItem } from "../support/api-stub";
import { expect, test } from "@playwright/test";

/**
 * 降级验证：刻意不拦截后端 API（不调 mockApi），验证即便后端不可达 /
 * 返回错误，AppShell 仍渲染外壳、导航可见、无未捕获页面崩溃（不白屏）。
 *
 * 前端对 API 失败的处理是落到 ErrorBanner / .ant-alert（已由组件测试覆盖），
 * 而非抛 React render error。本用例确保该降级在生产态也不破防。
 */
test("后端不可达时页面仍渲染外壳、不白屏", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");

  // 外壳与导航必须可见，证明未白屏。
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  await expect(navItem(page, "工作台")).toBeVisible();

  // 允许出现业务层错误提示（.ant-alert），但不允许 React 未捕获崩溃。
  expect(errors).toEqual([]);
});

test("后端不可达：进入资金中心不白屏（列表接口失败降级）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await navItem(page, "资金中心").click();
  await expect(page.locator(".topbar__page")).toHaveText("资金中心");

  // 主内容区可见：证明即便 pools/funds 接口失败，页面仍挂载而非崩溃。
  await expect(page.locator("main, .app-main, [class*='content']").first()).toBeVisible();
  expect(errors).toEqual([]);
});
