import { expect, test } from "@playwright/test";

test("业务操作弹窗的取消与保存按钮左右边缘对齐", async ({ page }) => {
  await page.goto("/#/business/inventory");
  await page.getByRole("tab", { name: "订单台账" }).click();

  const ledger = page.getByRole("tabpanel", { name: "订单台账" });
  await ledger.getByRole("button", { name: "更多", exact: true }).first().click();
  await page.getByText("资金收支", { exact: true }).click();

  const footer = page.locator(".business-registration-modal .ant-modal-footer").last();
  await expect(footer).toBeVisible();
  const buttons = footer.locator(":scope > .ant-btn");
  await expect(buttons).toHaveCount(2);

  const metrics = await buttons.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      marginInlineStart: style.marginInlineStart,
      marginLeft: style.marginLeft,
    };
  }));

  expect(metrics[1].left).toBe(metrics[0].left);
  expect(metrics[1].width).toBe(metrics[0].width);
  expect(metrics[1].marginInlineStart).toBe("0px");
  expect(metrics[1].marginLeft).toBe("0px");
});
