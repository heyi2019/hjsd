import { expect, test } from "@playwright/test";
import { NAV_LABELS, navItem } from "./support/api-stub";

/**
 * 导航冒烟：验证 AppShell 在 DEV 态零登录即可挂载，6 个主导航入口逐个可达，
 * 点击后顶栏页面标题更新、主内容区可见、无未捕获页面错误（不白屏）。
 *
 * 不拦截后端 API（与 fallback 一致）：后端不可达时前端走 ErrorBanner 降级、
 * 不抛错，恰好验证「生产态后端抖动也不白屏」。各页面的数据渲染逻辑已由
 * 组件测试（vitest）覆盖，E2E 只守「外壳 + 导航」这条主干。
 */
test("AppShell 渲染且 6 个导航入口齐全", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();

  for (const label of NAV_LABELS) {
    await expect(navItem(page, label)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

for (const label of NAV_LABELS) {
  test(`导航可达：${label}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await navItem(page, label).click();

    // 顶栏页面标题随导航更新（src/app/AppShell.tsx 的 .topbar__page）。
    await expect(page.locator(".topbar__page")).toHaveText(label);
    // 被点击项获得 aria-current=page（组件测试的导航一致性契约）。
    await expect(
      navItem(page, label),
    ).toHaveAttribute("aria-current", "page");
    // 主内容区可见：证明页面挂载而非白屏。
    await expect(page.locator("main, .app-main, [class*='content']").first()).toBeVisible();

    expect(errors).toEqual([]);
  });
}
