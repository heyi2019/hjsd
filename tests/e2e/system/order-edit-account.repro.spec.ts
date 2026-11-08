import { expect, test } from "@playwright/test";

/**
 * 复现 #15 需求1：订单台账行的「编辑账号」入口是否进入与库存中心一致的编辑态。
 * 走真实 E2E 后端（8124，heijin_erp_e2e 库，含 122 条带 account_id 的订单）+ E2E 前端（5181）。
 * 不手搓数据、不走页面 stub。
 */
test.describe("订单台账 编辑账号 入口复现 (#15 需求1)", () => {
  test("点击订单行的「编辑账号」进入编辑态且无控制台错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push("CONSOLE: " + m.text());
    });
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e.stack || e.message)));

    await page.goto("/");
    await page.getByText("业务中心", { exact: true }).first().click();
    await page.getByRole("tab", { name: "订单台账" }).click();
    await page.waitForTimeout(2500);

    const editButton = page.getByRole("button", { name: "编辑账号" }).first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    await expect(page.getByText("保存修改")).toBeVisible();
    await expect(page.getByLabel("编辑游戏账号/产品")).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
