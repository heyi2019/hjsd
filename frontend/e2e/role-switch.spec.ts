import { expect, test } from "@playwright/test";
import { NAV_LABELS, navItem } from "./support/api-stub";

/**
 * 角色切换（DEV 态）：验证开发态角色入口存在，且预设 viewer 角色后
 * 导航依然完整、页面不白屏（权限门生效但不破坏外壳渲染）。
 *
 * 不拦截后端 API：后端不可达走 ErrorBanner 降级，恰好验证降级不破防。
 * 角色写入走 localStorage key `hj.dev-user`（src/shared/api/client.ts），
 * 与 UI 上的角色 Select 等价，且避开 antd Select 下拉操作的脆弱性。
 */
test("DEV 态角色展示可见（角色由开发环境配置）", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  // 角色是只读展示，不提供运行时下拉切换，避免误导为可自行切换权限。
  await expect(page.locator(".topbar-role")).toContainText("当前角色（开发态）");
  await expect(page.locator(".topbar-role-name")).toContainText("系统管理员");
  expect(errors).toEqual([]);
});

test("预设 viewer 角色后导航仍完整可见", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.addInitScript(() => {
    localStorage.setItem("hj.dev-user", "viewer");
  });
  await page.goto("/");

  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  for (const label of NAV_LABELS) {
    await expect(navItem(page, label)).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("默认 dev 角色为 admin（不预设即 admin）", async ({ page }) => {
  await page.goto("/");
  // 角色只读文本应含「系统管理员」。
  await expect(page.locator(".topbar-role-name")).toContainText("系统管理员");
  await expect(navItem(page, "工作台")).toBeVisible();
});
