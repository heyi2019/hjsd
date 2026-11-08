import { expect, test } from "@playwright/test";

/**
 * 业务操作弹窗（资金收支 / RefundModal）的「取消」与「保存」按钮左右边缘对齐。
 *
 * 当前弹窗底部操作区契约：
 *  - 订单台账行内动作为**直接按钮**（编辑 / 分润 / 资金收支 / 取消），不再有「更多⌄」下拉；
 *    故直接点行内「资金收支」按钮，而非先点「更多」再点菜单项。
 *  - 资金收支弹窗是 `BusinessActionModal`（标题「资金收支 · 订单号」），其 footer 就是
 *    标准 antd `.ant-modal-footer`，不再挂 `.business-registration-modal` 类。
 *
 * 自给自足：先用 API 建一张 HS 订单（关联在库 RECOVERY 账号），保证台账里有可点的行，
 * 不依赖其他用例的副作用（旧写法依赖 business-write 提前建单，孤立运行会无行可点）。
 */
const API_BASE = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api/v1";
const ADMIN = { "X-Dev-User": "admin" };

test("业务操作弹窗的取消与保存按钮左右边缘对齐", async ({ page, request }) => {
  // 1) 造一张 HS 订单，确保台账有行可点。
  const accounts = (await request.get(`${API_BASE}/stocks`, { headers: ADMIN }).then((r) => r.json())) as {
    items: Array<{ id: number; inventory_status: string; inventory_type?: string }>;
  };
  const account = accounts.items.find(
    (a) => a.inventory_status === "IN_STOCK" && a.inventory_type === "RECOVERY",
  );
  expect(account, "缺少 RECOVERY 在库测试账号").toBeTruthy();
  const created = await request.post(`${API_BASE}/orders`, {
    headers: ADMIN,
    data: { order_type: "HS", account_id: account!.id, trade_date: "2026-10-21" },
  });
  expect(created.status()).toBe(201);
  const orderNo = (await created.json()).order_no as string;

  // 2) 进入订单台账，搜索并点开该单的「资金收支」弹窗。
  await page.goto("/#/business/ledger");
  await page.getByLabel("搜索订单").fill(orderNo);
  const row = page.getByRole("row").filter({ hasText: orderNo }).first();
  await row.getByRole("button", { name: "资金收支", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: /资金收支/ });
  await expect(dialog).toBeVisible();

  const footer = dialog.locator(".ant-modal-footer").last();
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
