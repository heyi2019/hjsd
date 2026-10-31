import { expect, test, type Locator } from "@playwright/test";
import { navItem } from "./support/api-stub";

/**
 * 填表并校验值真的落进去了。
 *
 * 坑：全量跑时机器高负载（实测 load 27），antd 受控输入偶发被 React 重渲染吞掉
 * fill——DOM 节点在 fill 落值前后被替换，字段空着但 fill 不报错；随后表单校验
 * 挡住提交，等 POST 响应 30s 超时（「资金流水页面提交审核」实测：金额空 +
 * invalid，摘要却正常）。故 fill 后校验 inputValue，丢失则重填一次，仍失败
 * 由 toHaveValue 给出明确报错。
 */
async function fillChecked(locator: Locator, value: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await locator.fill(value);
    if ((await locator.inputValue().catch(() => "")) === value) return;
  }
  await expect(locator).toHaveValue(value);
}

test("资金中心页面划转后生成一收一支的内部资金流水", async ({ page }) => {
  await page.goto("/");
  await navItem(page, "资金中心").click();
  await page.getByRole("button", { name: "资金池划转" }).click();
  const dialog = page.getByRole("dialog", { name: "资金池划转" });
  await dialog.locator(".ant-select-selector").first().click();
  await page.getByTitle("利润荷包（HJ_PROFIT）").last().click();
  await dialog.locator(".ant-select-selector").last().click();
  await page.getByTitle("投资款荷包（HJ_INVEST）").last().click();
  await dialog.getByLabel("划转金额").fill("1.00");
  const response = page.waitForResponse(r => r.url().endsWith("/transfers") && r.request().method() === "POST");
  await dialog.getByRole("button", { name: "确认划转" }).click();
  const result = await response;
  expect(result.status()).toBe(201);
  const body = await result.json();
  expect(body.cashflows).toHaveLength(2);
  expect(body.cashflows.map((f: { direction: string; amount: string; fund_nature: string }) => [f.direction, Number(f.amount), f.fund_nature]).sort()).toEqual([["IN", 1, "INTERNAL"], ["OUT", 1, "INTERNAL"]]);
  await expect(dialog).toBeHidden();
});

test("分期页面收款结清后交付，不重复产生流水", async ({ page, request }) => {
  const base = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const stocksResponse = await request.get(`${base}/stocks`, { headers });
  expect(stocksResponse.ok()).toBe(true);
  const account = ((await stocksResponse.json()).items as Array<{ id: number; inventory_status: string; inventory_type?: string }>).find(
    (item) => item.inventory_status === "IN_STOCK" && item.inventory_type === "RECOVERY",
  );
  expect(account, "缺少 RECOVERY 在库测试账号").toBeTruthy();
  const created = await request.post(`${base}/orders`, { headers, data: { order_type: "HS", trade_date: "2026-10-17", account_id: account!.id } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const buyEvent = await request.post(`${base}/orders/${order.id}/events`, { headers, data: { event_type: "BUY", amount: "100", occurred_on: "2026-10-17" } });
  expect(buyEvent.status()).toBe(201);
  const response = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "STOCK_SALE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(response.status()).toBe(201);
  const installment = await response.json();
  await page.goto("/");
  await navItem(page, "业务中心").click();
  await page.getByRole("tab", { name: "分期与回款" }).click();
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
  await delivery.locator(".ant-select-selector").click();
  await page.getByTitle("客户自行换绑").last().click();
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

test("资金流水页面新增即入账并在列表显示", async ({ page }) => {
  await page.goto("/");
  await navItem(page, "资金中心").click();
  await page.getByRole("tab", { name: "流水" }).click();
  await page.getByRole("button", { name: "新增流水" }).click();
  const dialog = page.getByRole("dialog", { name: "新增独立资金流水" });
  await dialog.locator(".ant-select-selector").first().click();
  await page.getByTitle("投资款荷包（HJ_INVEST）").last().click();
  await dialog.getByLabel("类别").fill("UI_TEST");
  await fillChecked(dialog.getByLabel("金额", { exact: true }), "12");
  await dialog.getByLabel("摘要").fill("页面联调资金入账");
  const create = page.waitForResponse(r => r.url().endsWith("/cashflows") && r.request().method() === "POST");
  // 口径：资金流水已取消审核/驳回，录入即入账（提交 3f7c115），按钮文案为「提交」。
  await dialog.getByRole("button", { name: "提交" }).click();
  const created = await create;
  expect(created.status()).toBe(201);
  const flow = await created.json();
  expect(flow.status).toBe("APPROVED");
  await expect(dialog).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: flow.flow_no });
  // 状态文案取自 option_set FUND_FLOW_STATUS（APPROVED → 「已审核」）。
  // 注：src 里 configurableLabel 的 fallback 写的是「已入账」，但配置优先，
  // 故实际渲染为「已审核」；两者文案不一致属产品待统一项，此处按实际渲染断言。
  await expect(row.getByText("已审核")).toBeVisible({ timeout: 5000 });
});


test("资金对账页面提交差异并核销", async ({ page }) => {
  await page.goto("/");
  await navItem(page, "资金中心").click();
  await page.getByRole("tab", { name: "对账" }).click();
  await page.getByRole("button", { name: "新增对账" }).click();
  const dialog = page.getByRole("dialog", { name: "新增资金对账" });
  await dialog.locator(".ant-select-selector").click();
  await page.getByTitle("投资款荷包（HJ_INVEST）").last().click();
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
