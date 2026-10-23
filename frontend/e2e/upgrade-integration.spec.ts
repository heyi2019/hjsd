import { test, expect } from "@playwright/test";
import { navItem } from "./support/api-stub";

const base = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
const headers = { "X-Dev-User": "admin" };

test("已交付分期订单可从页面登记退款", async ({ page, request }) => {
  const created = await request.post(`${base}/orders`, { headers, data: { order_type: "DFQ", trade_date: "2026-10-17" } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const installment = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "ADVANCE_PURCHASE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(installment.status()).toBe(201);
  const contract = await installment.json();
  const payment = await request.post(`${base}/installments/${contract.id}/payments`, { headers, data: { amount: "100", paid_on: "2026-10-17", period_no: 1 } });
  expect(payment.status()).toBe(200);
  const delivered = await request.post(`${base}/installments/${contract.id}/deliver`, { headers, data: { delivery_mode: "CUSTOMER_SELF", delivered_on: "2026-10-17", note: "联调交付凭证" } });
  expect(delivered.status()).toBe(200);
  await page.goto("/");
  await navItem(page, "业务中心").click();
  // 业务中心默认落 URL 指定的 Tab（导航进来是 #/business/inventory 库存中心），
  // 「搜索订单」只在「业务台账」面板内，必须先切 Tab。
  await page.getByRole("tab", { name: "业务台账" }).click();
  await page.getByLabel("搜索订单").fill(order.order_no);
  await page.getByRole("row").filter({ hasText: order.order_no }).getByText("查看详情").click();
  const drawer = page.locator(".ant-drawer-content");
  // 「登记退款」收在 Drawer 的「更多⌄」下拉菜单里，不是直接渲染的按钮。
  await drawer.getByRole("button", { name: /更多/ }).click();
  await page.getByRole("menuitem", { name: "登记退款" }).click();
  const modal = page.locator(".ant-modal-content");
  await modal.getByPlaceholder("请输入退款金额").fill("30");
  await modal.getByPlaceholder("请输入退款原因").fill("联调退款");
  const response = page.waitForResponse(r => r.url().endsWith(`/orders/${order.id}/events`) && r.request().method() === "POST");
  await modal.getByRole("button", { name: /确\s*定/ }).click();
  expect((await response).status()).toBe(201);
  const detail = await request.get(`${base}/orders/${order.id}`, { headers });
  const body = await detail.json();
  expect(body.events.some((event: { event_type: string; amount: string }) => event.event_type === "REFUND" && Number(event.amount) === 30)).toBe(true);
});

test("利润分配页面保存四项比例并允许同一人承担多个动作", async ({ page, request }) => {
  const created = await request.post(`${base}/orders`, { headers, data: { order_type: "DFQ", trade_date: "2026-10-17" } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const contract = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "ADVANCE_PURCHASE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(contract.status()).toBe(201);
  const buy = await request.post(`${base}/orders/${order.id}/events`, { headers, data: { event_type: "BUY", amount: "100", occurred_on: "2026-10-17" } });
  expect(buy.status()).toBe(201);
  await page.goto("/");
  await navItem(page, "业务中心").click();
  // 业务中心默认落 URL 指定的 Tab（导航进来是 #/business/inventory 库存中心），
  // 「搜索订单」只在「业务台账」面板内，必须先切 Tab。
  await page.getByRole("tab", { name: "业务台账" }).click();
  await page.getByLabel("搜索订单").fill(order.order_no);
  await page.getByRole("row").filter({ hasText: order.order_no }).getByText("查看详情").click();
  // 「利润分配」同样收在 Drawer 的「更多⌄」下拉菜单内。
  await page.locator(".ant-drawer-content").getByRole("button", { name: /更多/ }).click();
  await page.getByRole("menuitem", { name: "利润分配" }).click();
  const modal = page.locator(".ant-modal-content");
  await expect(modal.getByText("利润分配 ·", { exact: false })).toBeVisible();
  const rows = modal.locator(".orders-allocation-row");
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) await row.locator('input[inputmode="decimal"]').fill("25");
  await rows.nth(2).locator(".ant-select-selector").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  const response = page.waitForResponse(r => r.url().endsWith(`/orders/${order.id}/profit-allocations`) && r.request().method() === "PUT");
  await modal.getByRole("button", { name: /确\s*定/ }).click();
  expect((await response).status()).toBe(200);
  const saved = await (await request.get(`${base}/orders/${order.id}/profit-allocations`, { headers })).json();
  expect(saved.items).toHaveLength(4);
  expect(saved.items.find((x: { allocation_type: string }) => x.allocation_type === "BUY").user_id).toBeTruthy();
  expect(saved.items.find((x: { allocation_type: string }) => x.allocation_type === "OPERATION").user_id).toBe(saved.items.find((x: { allocation_type: string }) => x.allocation_type === "BUY").user_id);
  expect(saved.items.find((x: { allocation_type: string }) => x.allocation_type === "COMPANY").user_id).toBeNull();
});

// 全量跑时前面已累积十余个写用例（e2e 库数据量上去后订单创建 + 返点到账 +
// 手续费 + 审计链变慢），单跑 ~16s 但全量曾贴 30s 超时边界偶发红，故显式放宽。
test.slow();
test("页面售出绑定操作人，返点到账保留收入并单独记录手续费", async ({ page, request }) => {
  const accountList = await (await request.get(`${base}/accounts`, { headers })).json();
  const account = accountList.find((a: { inventory_type: string; status: string; game_account: string }) => a.inventory_type === "CONSIGNMENT" && a.status === "IN_STOCK" && a.game_account);
  expect(account).toBeTruthy();
  const users = await (await request.get(`${base}/users`, { headers })).json();
  const admin = users.find((u: { username: string }) => u.username === "admin");
  expect(admin).toBeTruthy();
  await page.goto("/");
  await navItem(page, "业务中心").click();
  await page.getByRole("tab", { name: "库存中心" }).click();
  await page.getByLabel("搜索库存账号").fill(account.game_account);
  await page.getByRole("row").filter({ hasText: account.game_account }).getByRole("button", { name: "售出" }).click();
  const saleModal = page.getByRole("dialog", { name: "售出账号" });
  await saleModal.locator(".ant-select-selector").first().click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  await saleModal.getByPlaceholder("请输入金额").fill("200");
  await saleModal.locator(".ant-select-selector").last().click();
  await page.getByTitle("投资款荷包（HJ_INVEST）").last().click();
  const orderResponse = page.waitForResponse(r => r.url().endsWith("/orders") && r.request().method() === "POST");
  const saleResponse = page.waitForResponse(r => /\/orders\/\d+\/events$/.test(r.url()) && r.request().method() === "POST");
  await saleModal.getByRole("button", { name: "确认售出" }).click();
  const created = await orderResponse;
  expect(created.status()).toBe(201);
  const order = await created.json();
  expect((await saleResponse).status()).toBe(201);
  const detail = await (await request.get(`${base}/orders/${order.id}`, { headers })).json();
  const sell = detail.events.find((e: { event_type: string }) => e.event_type === "SELL");
  expect(sell.created_by ?? sell.operator).toBe("admin");
  const allocations = await request.put(`${base}/orders/${order.id}/profit-allocations`, { headers, data: { items: [
    { allocation_type: "BUY", role: "OWNER", allocation_rate: "25" },
    { allocation_type: "SELL", role: "OWNER", allocation_rate: "25" },
    { allocation_type: "OPERATION", user_id: admin.id, role: "OWNER", allocation_rate: "25" },
    { allocation_type: "COMPANY", role: "OWNER", allocation_rate: "25" },
  ] } });
  expect(allocations.status()).toBe(200);
  expect((await allocations.json()).items.find((a: { allocation_type: string }) => a.allocation_type === "SELL").user_id).toBe(admin.id);
  const rebateResponse = await request.post(`${base}/rebates`, { headers, data: { source_order_id: order.id, rebate_type: "SELL", base_amount: "100", rate: "0", collected_on: "2026-10-17" } });
  expect(rebateResponse.status()).toBe(201);
  const rebate = await rebateResponse.json();
  await navItem(page, "资金中心").click();
  await page.getByRole("tab", { name: "返点" }).click();
  await page.getByRole("row").filter({ hasText: rebate.rebate_no }).getByRole("button", { name: "登记结算" }).click();
  const settle = page.getByRole("dialog", { name: `返点到账 · ${rebate.rebate_no}` });
  await settle.getByLabel("到账金额").fill("100");
  await settle.getByLabel("平台手续费（自动生成费用流水）").fill("10");
  await settle.locator(".ant-select-selector").click();
  await page.locator(".ant-select-dropdown:visible .ant-select-item-option").first().click();
  const settlement = page.waitForResponse(r => r.url().endsWith(`/rebates/${rebate.id}/settlements`) && r.request().method() === "POST");
  await settle.getByRole("button", { name: "确认结算" }).click();
  expect((await settlement).status()).toBe(201);
  // /cashflows 返回 { items, total } 信封，不是裸数组。
  const flows = await (await request.get(`${base}/cashflows?order_id=${order.id}`, { headers })).json();
  const income = flows.items.find((f: { category: string }) => f.category === "REBATE");
  const fee = flows.items.find((f: { category: string }) => f.category === "REBATE_FEE");
  expect([income.direction, Number(income.amount), income.accounting_attribute]).toEqual(["IN", 100, "REBATE_INCOME"]);
  expect([fee.direction, Number(fee.amount), fee.accounting_attribute]).toEqual(["OUT", 10, "OPERATING_EXPENSE"]);
});
