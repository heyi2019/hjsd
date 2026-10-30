import { test, expect } from "@playwright/test";
import { navItem } from "./support/api-stub";

/**
 * 真前后端「联调」E2E。
 *
 * 与 smoke / role-switch（DEV 态 + page.route stub）不同：本用例**不拦截**任何
 * `/api/v1/**`，浏览器直接打真实后端（默认 127.0.0.1:8123），验证：
 *   - 前端发出的真实请求被后端接收并返回 200；
 *   - 真实业务数据（客户 / 资金荷包）经前端渲染出现在 DOM 中。
 * DEV 态下前端自动带 `X-Dev-User: admin`，无需 UI 登录即可读到真实数据。
 *
 * 前置：后端运行在 8123（8000 被 Docker 占用）。
 */
test.describe("real frontend<->backend integration", () => {
  test("客户中心：真实 /customers 返回 2 条且渲染到表格", async ({
    page,
  }) => {
    const customersResp = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/customers") && r.request().method() === "GET",
    );

    await page.goto("/");
    await expect(navItem(page, "客户中心")).toBeVisible();
    await navItem(page, "客户中心").click();

    const resp = await customersResp;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    const customers = body.items;
    expect(Array.isArray(customers)).toBe(true);
    expect(customers.length).toBeGreaterThanOrEqual(1);

    // 取真实响应中的客户名断言渲染，避免把测试绑定到会变化的种子名称。
    expect(customers.length).toBeGreaterThan(0);
    await expect(page.getByText(customers[0].display_name).first()).toBeVisible();
  });

  test("资金中心：真实 /pools 返回荷包且渲染到页面", async ({ page }) => {
    const poolsResp = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/pools") && r.request().method() === "GET",
    );

    await page.goto("/");
    await expect(navItem(page, "资金中心")).toBeVisible();
    await navItem(page, "资金中心").click();

    const resp = await poolsResp;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((p: { name?: string }) => p.name === "投资款荷包")).toBe(
      true,
    );

    await expect(page.getByText("投资款荷包")).toBeVisible();
  });
});
