import { expect, test } from "@playwright/test";

/**
 * E2E-B01-014：返点弹窗的「编辑返点」内层弹窗关闭路径。
 *
 * 背景：内层编辑弹窗原先渲染在外层「登记返点」的 children 里（Modal 套 Modal）。
 * 后果是 React 合成事件的捕获阶段会沿 fiber 树回溯到外层内容根，
 * 外层挂在内容根上的 Esc 捕获处理器同样收到内层的按键 —— 在编辑弹窗按 Esc，
 * 「登记返点」一起被关掉，外层已填的返点金额直接丢失。
 * 修复方式：让内层与外层成为兄弟节点（不再作为 children）。
 *
 * 自给自足：先用 API 建 HS 单 + BUY 返点，保证明细表里有可点的「编辑」行。
 */
const API_BASE = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api";
const ADMIN = { "X-Dev-User": "admin" };

test("返点弹窗的内层编辑弹窗可关闭，且不连带关闭外层", async ({ page, request }) => {
  test.setTimeout(60_000);
  const stocks = (await request.get(`${API_BASE}/stocks?page_size=200`, { headers: ADMIN }).then((r) => r.json())) as {
    items: Array<{ id: number; game_account: string; inventory_status: string; inventory_type?: string }>;
  };
  const account = stocks.items.find((a) => a.inventory_status === "IN_STOCK" && a.inventory_type === "RECOVERY");
  expect(account, "缺少 RECOVERY 在库账号").toBeTruthy();

  const orderRes = await request.post(`${API_BASE}/orders`, {
    headers: ADMIN,
    data: { order_type: "HS", account_id: account!.id, trade_date: "2026-11-01" },
  });
  expect(orderRes.status(), await orderRes.text()).toBe(201);
  const order = (await orderRes.json()) as { id: number };

  const created = await request.post(`${API_BASE}/rebates`, {
    headers: ADMIN,
    data: {
      source_order_id: order.id,
      rebate_type: "BUY",
      amount: "100.00",
      collected_on: "2026-11-01",
      channel: "买号返点",
    },
  });
  expect(created.status(), await created.text()).toBeLessThan(300);

  await page.goto("/#/business/inventory");
  await page.getByLabel("搜索库存账号").fill(account!.game_account);
  const row = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: account!.game_account, exact: true }),
  }).first();
  await expect(row).toBeVisible();
  await row.getByLabel("返点").click();

  const outer = page.getByRole("dialog", { name: /登记返点/ });
  await expect(outer).toBeVisible();
  await expect(outer.getByRole("row").filter({ hasText: "买号返点" }).first()).toBeVisible({ timeout: 15000 });

  // 打开内层「编辑返点」
  const edit = page.getByRole("dialog", { name: /编辑返点/ });
  await outer.getByRole("button", { name: "编辑" }).first().click();
  await expect(edit).toBeVisible();

  // 1) 内层 X：只关内层，外层必须留在原地（否则外层已填内容被连带丢弃）
  await edit.locator(".ant-modal-close").first().click();
  await expect(edit).toBeHidden({ timeout: 5000 });
  await expect(outer).toBeVisible();

  // 2) 再开一次后按 Esc：焦点仍在底层触发按钮上，关闭的必须是上层的内层弹窗，
  //    外层「登记返点」保留（否则已填的返点金额被连带丢弃）。
  await outer.getByRole("button", { name: "编辑" }).first().click();
  await expect(edit).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(edit).toBeHidden({ timeout: 5000 });
  await expect(outer).toBeVisible();

  // 3) 原「明细行删除确认气泡」步骤已随「返点无作废/删除」口径下线（明细行不再有删除按钮），
  //    内嵌浮层 Esc 不连带关弹窗的行为由第 2 步（内层编辑弹窗 Esc）继续覆盖。

  // 4) 焦点停在弹窗容器（未点任何字段）时，Esc 也要能关掉这一层
  await page.keyboard.press("Escape");
  await expect(outer).toBeHidden({ timeout: 5000 });
});
