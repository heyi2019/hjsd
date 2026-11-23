import { test, expect } from "@playwright/test";
import { navItem } from "../support/api-stub";

const base = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api";
const headers = { "X-Dev-User": "admin" };

test("已交付分期订单可从页面登记退款", async ({ page, request }) => {
  const created = await request.post(`${base}/orders`, { headers, data: {
    order_type: "HS", trade_date: "2026-10-17",
    account_snapshot: { game_account: `e2e-refund-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1] },
  } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const buyEvent = await request.post(`${base}/orders/${order.id}/events`, { headers, data: { event_type: "BUY", amount: "100", occurred_on: "2026-10-17" } });
  expect(buyEvent.status()).toBe(201);
  const installment = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "STOCK_SALE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(installment.status()).toBe(201);
  const contract = await installment.json();
  const payment = await request.post(`${base}/installments/${contract.id}/payments`, { headers, data: { amount: "100", paid_on: "2026-10-17", period_no: 1 } });
  expect(payment.status()).toBe(200);
  const delivered = await request.post(`${base}/installments/${contract.id}/deliver`, { headers, data: { delivered_on: "2026-10-17", note: "联调交付凭证" } });
  expect(delivered.status()).toBe(200);
  await page.goto("/");
  await navItem(page, "业务中心").click();
  // 业务中心默认落 URL 指定的 Tab（导航进来是 #/business/inventory 库存中心），
  // 「搜索订单」只在「订单台账」面板内，必须先切 Tab。
  await page.getByRole("tab", { name: "订单台账" }).click();
  await page.getByLabel("搜索订单").fill(order.order_no);
  const row = page.getByRole("row").filter({ hasText: order.order_no }).first();
  // 订单台账行内动作现为**直接按钮**（编辑 / 分润配置 / 分润 / 资金收支 / 取消），不再有「更多⌄」下拉。
  await row.getByRole("button", { name: "资金收支", exact: true }).click();
  const modal = page.getByRole("dialog", { name: /资金收支/ });
  // 退款作为订单资金明细登记，不产生 REFUND 业务事件。
  await modal.getByPlaceholder("请输入资金金额").fill("30");
  await modal.getByPlaceholder("请输入收支备注").fill("联调退款");
  await modal.locator('.ant-form-item:has(.ant-form-item-label:has-text("资金账户")) .ant-select-selector').click();
  await page.getByTitle("投资款荷包", { exact: true }).last().click();
  // 提交走订单资金明细接口（POST /orders/{id}/cashflows），不再 POST /orders/{id}/events。
  const response = page.waitForResponse(r => r.url().endsWith(`/orders/${order.id}/cashflows`) && r.request().method() === "POST");
  await modal.getByRole("button", { name: /确\s*定/ }).click();
  expect((await response).status()).toBe(201);
  // 断言口径：订单下新增一笔支出（OUT）资金明细，金额 30、原因 OTHER（响应为 { items } 信封）。
  const flows = (await (await request.get(`${base}/cashflows?order_id=${order.id}`, { headers })).json()) as {
    items: Array<{ direction: string; amount: string; category: string; note?: string | null }>;
  };
  const refundFlow = flows.items.find(
    (flow) => flow.direction === "OUT" && Number(flow.amount) === 30 && flow.category === "OTHER",
  );
  expect(refundFlow, "订单下应有一笔 30 元支出资金明细").toBeTruthy();
  expect(refundFlow!.note).toBe("联调退款");
});

test.describe.serial("重写入用例（串行隔离）", () => {
  test("页面售出绑定操作人，返点登记后在返点明细可见", async ({ page, request }) => {
    const gameAccount = `e2e-sale-rebate-${Date.now()}`;
    const sourceOrder = await request.post(`${base}/orders`, {
      headers,
      data: { order_type: "DG", trade_date: "2026-10-17",
        account_snapshot: { game_account: gameAccount, game_type: "王者荣耀" },
        form_extra: { business_responsible_ids: [1] } },
    });
    expect(sourceOrder.status(), await sourceOrder.text()).toBe(201);
    const order = await sourceOrder.json();
    const users = await (await request.get(`${base}/users`, { headers })).json();
    const admin = users.find((u: { username: string }) => u.username === "admin");
    expect(admin).toBeTruthy();
    await page.goto("/");
    await navItem(page, "业务中心").click();
    await page.getByRole("tab", { name: "库存中心" }).click();
    await page.getByRole("searchbox", { name: "搜索库存账号" }).fill(gameAccount);
    // 搜索为子串匹配：e2e_consignment_1 会同时命中 _1/_10/_11/_12，故必须用「精确单元格文本」
    // 定位目标行，否则 .first() 会点进按最新排序的 _12 等误匹配行。
    const targetRow = page
      .getByRole("row")
      .filter({ has: page.getByText(gameAccount, { exact: true }) })
      .first();
    await targetRow.getByRole("button", { name: "售出" }).click();
    // 代挂账号的售出弹窗标题为「售出代挂账号」（非回收/提号的「售出回收/提号账号」），用正则匹配。
    const saleModal = page.getByRole("dialog", { name: /售出.*账号/ });

    // 后端按委托方昵称复用或建立客户并关联原订单。
    const buyerName = `E2E买家-${Date.now()}`;
    await saleModal.getByLabel("委托方昵称").fill(buyerName);
    await saleModal.locator('.ant-form-item:has(.ant-form-item-label:has-text("售出操作人")) .ant-select-selector').click();
    await page.getByTitle("系统管理员", { exact: true }).last().click();
    await saleModal.getByRole("heading", { name: "委托方信息" }).click();
    await expect(page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")).toHaveCount(0);

    await saleModal.getByPlaceholder("请输入利润（代挂佣金）").fill("200");

    await saleModal
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("资金账户"))')
      .locator(".ant-select-selector")
      .click();
    await page.getByTitle("投资款荷包", { exact: true }).last().click();

    // 售出通过专用接口登记到原订单，接口同时处理客户及交付信息。
    const saleResponse = page.waitForResponse(r => r.url().endsWith(`/orders/${order.id}/stock-sale`) && r.request().method() === "POST");
    await saleModal.getByRole("button", { name: "确认售出" }).click();
    const saleRes = await saleResponse;
    expect(saleRes.status()).toBe(201);
    expect(new URL(saleRes.url()).pathname).toBe(`/api/orders/${order.id}/stock-sale`);
    const detail = await (await request.get(`${base}/orders/${order.id}`, { headers })).json();
    // 库存统一口径：代挂（CONSIGNMENT）售出映射为 DG 订单类型。
    expect(detail.order_type).toBe("DG");
    const sell = detail.events.find((e: { event_type: string }) => e.event_type === "SELL");
    expect(sell.operator_user_ids).toContain(admin.id);
    // 售出→返点建链：DG 订单可建 SELL 类型返点（rebates.py 要求 order_type==DG）。
    const rebateResponse = await request.post(`${base}/rebates`, { headers, data: { source_order_id: order.id, rebate_type: "SELL", amount: "100", collected_on: "2026-10-17" } });
    expect(rebateResponse.status()).toBe(201);
    // 口径变更：返点结算模型已重构——DG 代挂沿用统一 SELL 事件登记卖出金额与利润，
    // 不再有独立「登记结算」流程，也不再生成 REBATE_FEE 手续费分录
    // （后端 /rebates/{id}/settlements 端点与 REBATE_FEE 类别均已移除）。
    // 返点收入在资金明细中随关联订单流水展示。
    await navItem(page, "资金中心").click();
    await page.getByRole("tab", { name: "资金明细" }).click();
    await page.getByRole("button", { name: "全部" }).click();
    await page.getByRole("searchbox", { name: "流水搜索" }).fill(detail.order_no);
    await page.getByRole("searchbox", { name: "流水搜索" }).press("Enter");
    await expect(page.getByRole("row").filter({ hasText: detail.order_no }).filter({ hasText: "返点" })).toBeVisible({ timeout: 10000 });
  });
});
