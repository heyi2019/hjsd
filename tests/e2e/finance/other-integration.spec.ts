import { expect, test } from "@playwright/test";
import { navItem } from "../support/api-stub";

test("资金中心页面划转后生成一收一支的内部资金流水", async ({ page }) => {
  await page.goto("/");
  await navItem(page, "资金中心").click();
  await page.getByRole("button", { name: "资金账户划转" }).click();
  const dialog = page.getByRole("dialog", { name: "资金账户划转" });
  await dialog.getByRole("combobox", { name: /转出资金池/ }).click();
  await page.getByTitle("利润荷包", { exact: true }).last().click();
  await dialog.getByRole("combobox", { name: /转入资金池/ }).click();
  await page.getByTitle("投资款荷包", { exact: true }).last().click();
  await dialog.getByLabel("划转金额").fill("1.00");
  const response = page.waitForResponse(r => r.url().endsWith("/transfers") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "确认划转" }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  const body = await result.json();
  expect(body.cashflows).toHaveLength(2);
  expect(body.cashflows.map((f: { direction: string; amount: string }) => [f.direction, Number(f.amount)]).sort()).toEqual([["IN", 1], ["OUT", 1]]);
  await expect(dialog).toBeHidden();
});

test("分期页面收款结清后交付，不重复产生流水", async ({ page, request }) => {
  const base = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const created = await request.post(`${base}/orders`, { headers, data: {
    order_type: "HS", trade_date: "2026-10-17",
    account_snapshot: { game_account: `e2e-instal-ui-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1] },
  } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const buyEvent = await request.post(`${base}/orders/${order.id}/events`, { headers, data: { event_type: "BUY", amount: "100", occurred_on: "2026-10-17" } });
  expect(buyEvent.status()).toBe(201);
  const response = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "STOCK_SALE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(response.status()).toBe(201);
  const installment = await response.json();
  await page.goto("/#/business/collections");
  const row = page.getByRole("row").filter({ hasText: installment.inst_no });
  await row.getByRole("button", { name: "登记收款" }).click();
  const dialog = page.getByRole("dialog", { name: `分期收款 · ${installment.inst_no}` });
  await dialog.getByLabel("本次实收").fill("100");
  const payment = page.waitForResponse(r => r.url().endsWith(`/installments/${installment.id}/payments`) && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "确认收款" }).click();
  const paymentResponse = await payment;
  expect(paymentResponse.status()).toBe(200);
  const detail = await paymentResponse.json();
  expect(Number(detail.installment.paid_amount)).toBe(100);
  expect(detail.installment.status).toBe("SETTLED");
  expect(Number(detail.schedule.received_amount)).toBe(100);
  await expect(dialog).toBeHidden();
  const flowsBefore = await (await request.get(`${base}/cashflows?order_id=${order.id}`, { headers })).json();
  await row.getByRole("button", { name: "换绑交付" }).click();
  const delivery = page.getByRole("dialog", { name: `换绑交付 · ${installment.inst_no}` });
  await delivery.getByLabel("换绑凭证").fill("页面联调交付凭证");
  const delivered = page.waitForResponse(r => r.url().endsWith(`/installments/${installment.id}/deliver`) && r.request().method() === "POST");
  await delivery.getByRole("button", { name: "确认交付" }).click();
  const deliveryResponse = await delivered;
  expect(deliveryResponse.status()).toBe(200);
  expect((await deliveryResponse.json()).status).toBe("DELIVERED");
  const flowsAfter = await (await request.get(`${base}/cashflows?order_id=${order.id}`, { headers })).json();
  expect(flowsAfter.items.length).toBe(flowsBefore.items.length);
  await expect(delivery).toBeHidden();
});

test("资金明细展示接口登记的真实流水", async ({ page, request }) => {
  const base = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api";
  const headers = { "X-Dev-User": "admin" };
  const pools = await (await request.get(`${base}/pools`, { headers })).json() as Array<{ id: number; code: string }>;
  const pool = pools.find((item) => item.code === "HJ_INVEST");
  expect(pool).toBeTruthy();
  const note = `页面联调资金明细-${Date.now()}`;
  const created = await request.post(`${base}/cashflows`, { headers, data: {
    pool_id: pool!.id, occurred_on: "2026-10-17", direction: "IN", category: "OTHER",
    amount: "12", note,
  } });
  expect(created.status()).toBe(201);
  const flow = await created.json();
  await page.goto("/");
  await navItem(page, "资金中心").click();
  await page.getByRole("tab", { name: "资金明细" }).click();
  await page.getByRole("button", { name: "全部" }).click();
  await page.getByRole("searchbox", { name: "流水搜索" }).fill(note);
  await page.getByRole("searchbox", { name: "流水搜索" }).press("Enter");
  const row = page.getByRole("row").filter({ hasText: flow.flow_no });
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row).toContainText(note);
});


test("资金对账页面提交差异并核销", async ({ page }) => {
  await page.goto("/");
  await navItem(page, "资金中心").click();
  await page.getByRole("tab", { name: "对账" }).click();
  await page.getByRole("button", { name: "新增对账" }).click();
  const dialog = page.getByRole("dialog", { name: "新增资金对账" });
  await dialog.getByRole("combobox", { name: "资金账户" }).click();
  await page.getByTitle("投资款荷包", { exact: true }).last().click();
  const label = `页面对账-${Date.now()}`;
  await dialog.getByLabel("对账账户").fill(label);
  // 校验规则：账面余额必须大于 0（填 0 会被表单拦截，onFinish 不触发 → 不发 POST）。
  // 本用例本就验证「差异」场景，账面填 100 与系统余额（0）形成差异，故必须填差异原因（下方已填）。
  await dialog.getByLabel("账面余额").fill("100.00");
  await dialog.getByLabel("差异原因").fill("页面联调对账差异");
  const create = page.waitForResponse(r => r.url().endsWith("/reconciliations") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "提交对账" }).click();
  const created = await create;
  expect(created.status()).toBe(201);
  const reconciliation = await created.json();
  expect(reconciliation.status).toBe("OPEN");
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: label });
  await row.getByRole("button", { name: /核\s*销/ }).click();
  const resolveDialog = page.getByRole("dialog", { name: "核销对账差异" });
  await resolveDialog.locator("textarea").fill("页面联调核销");
  const resolved = page.waitForResponse(r => r.url().endsWith(`/reconciliations/${reconciliation.id}/resolve`) && r.request().method() === "POST");
  await resolveDialog.getByRole("button", { name: "确认核销" }).click();
  const result = await resolved;
  expect(result.status()).toBe(200);
  expect((await result.json()).status).toBe("RESOLVED");
});
