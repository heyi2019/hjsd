import { test, expect } from "@playwright/test";
import { navItem } from "./support/api-stub";

const base = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api/v1";
const headers = { "X-Dev-User": "admin" };

test("已交付分期订单可从页面登记退款", async ({ page, request }) => {
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
  const installment = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "STOCK_SALE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(installment.status()).toBe(201);
  const contract = await installment.json();
  const payment = await request.post(`${base}/installments/${contract.id}/payments`, { headers, data: { amount: "100", paid_on: "2026-10-17", period_no: 1 } });
  expect(payment.status()).toBe(200);
  const delivered = await request.post(`${base}/installments/${contract.id}/deliver`, { headers, data: { delivery_mode: "CUSTOMER_SELF", delivered_on: "2026-10-17", note: "联调交付凭证" } });
  expect(delivered.status()).toBe(200);
  await page.goto("/");
  await navItem(page, "业务中心").click();
  // 业务中心默认落 URL 指定的 Tab（导航进来是 #/business/inventory 库存中心），
  // 「搜索订单」只在「订单台账」面板内，必须先切 Tab。
  await page.getByRole("tab", { name: "订单台账" }).click();
  await page.getByLabel("搜索订单").fill(order.order_no);
  const row = page.getByRole("row").filter({ hasText: order.order_no }).first();
  // 订单台账行内动作现为**直接按钮**（编辑 / 分润 / 资金收支 / 取消），不再有「更多⌄」下拉。
  await row.getByRole("button", { name: "资金收支", exact: true }).click();
  const modal = page.getByRole("dialog", { name: /资金收支/ });
  // 资金收支表单字段口径（0057 迁移：订单退款表单调整为资金支出表单）：
  // 金额（placeholder 请输入退款金额）、收支备注（placeholder 请输入收支备注）、发生日期、操作人。
  await modal.getByPlaceholder("请输入退款金额").fill("30");
  await modal.getByPlaceholder("请输入收支备注").fill("联调退款");
  const response = page.waitForResponse(r => r.url().endsWith(`/orders/${order.id}/events`) && r.request().method() === "POST");
  await modal.getByRole("button", { name: /确\s*定/ }).click();
  expect((await response).status()).toBe(201);
  const detail = await request.get(`${base}/orders/${order.id}`, { headers });
  const body = await detail.json();
  expect(body.events.some((event: { event_type: string; amount: string }) => event.event_type === "REFUND" && Number(event.amount) === 30)).toBe(true);
});

test("分润弹窗默认按操作模型保存四项比例", async ({ page, request }) => {
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
  const contract = await request.post(`${base}/installments`, { headers, data: { order_id: order.id, contract_type: "STOCK_SALE", principal: "100", down_payment: "0", periods: 1, per_period: "100", first_due_on: "2026-10-17" } });
  expect(contract.status()).toBe(201);
  const buy = await request.post(`${base}/orders/${order.id}/events`, { headers, data: { event_type: "BUY", amount: "100", occurred_on: "2026-10-17" } });
  expect(buy.status()).toBe(201);

  // 取一个在职用户（admin）作为分润绑人对象；分润弹窗默认「按操作」模型，
  // 买号/运营动作位绑人，售出/公司位禁用不绑人。
  const users = (await (await request.get(`${base}/users`, { headers })).json()) as Array<{ id: number; username: string; is_active: boolean }>;
  const pick = users.find((u) => u.is_active && u.username === "admin")!;
  expect(pick, "缺少在职 admin 用户").toBeTruthy();

  await page.goto("/");
  await navItem(page, "业务中心").click();
  // 业务中心默认落 URL 指定的 Tab（导航进来是 #/business/inventory 库存中心），
  // 「搜索订单」只在「订单台账」面板内，必须先切 Tab。
  await page.getByRole("tab", { name: "订单台账" }).click();
  await page.getByLabel("搜索订单").fill(order.order_no);
  // 订单台账行内动作现为**直接按钮**（编辑 / 分润 / 资金收支 / 取消），不再有「更多⌄」下拉。
  await page
    .getByRole("row")
    .filter({ hasText: order.order_no })
    .first()
    .getByRole("button", { name: "分润", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: /分润/ });
  // 新单无存量分润 → 分润弹窗默认「按操作」模型：买号/售出/运营/公司 四项固定结构，
  // 不再有「增加一行」按人模型（按人模型仅在订单已存按人分润时回显）。
  await expect(dialog.getByText(`分润 · ${order.order_no}`, { exact: false })).toBeVisible();

  // 四项各填 25%（合计 100%）；买号（BUY 已入账）/运营 动作位绑 admin，
  // 售出（无 SELL 事件）禁用不绑人、公司位固定不绑人。
  // 行顺序固定为 [买号, 售出, 运营, 公司]（actionKinds 常量），按索引定位最稳。
  const actionRows = dialog.locator(".orders-allocation-row.is-action");
  await expect(actionRows).toHaveCount(4);
  const kinds = ["买号", "售出", "运营", "公司"] as const;
  const bindable = new Set(["买号", "运营"]);
  for (let i = 0; i < 4; i += 1) {
    const kind = kinds[i];
    if (bindable.has(kind)) {
      await actionRows.nth(i).locator(".ant-select-selector").first().click();
      await page
        .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)")
        .last()
        .locator(".ant-select-item-option", { hasText: pick.username })
        .first()
        .click();
    }
    await actionRows.nth(i).locator('.ant-form-item:has(.ant-form-item-label:has-text("比例")) input').fill("25");
  }

  const response = page.waitForResponse(
    (r) => r.url().endsWith(`/orders/${order.id}/profit-allocations`) && r.request().method() === "PUT",
  );
  await dialog.getByRole("button", { name: /确\s*定/ }).click();
  expect((await response).status()).toBe(200);

  const saved = await (await request.get(`${base}/orders/${order.id}/profit-allocations`, { headers })).json();
  expect(saved.items).toHaveLength(4);
  // 按操作模型：BUY/SELL/OPERATION 绑定人（有 user_id），COMPANY 固定不绑人。
  const byType: Record<string, { user_id: number | null }> = {};
  for (const it of saved.items as Array<{ allocation_type: string; user_id: number | null }>) {
    byType[it.allocation_type] = { user_id: it.user_id };
  }
  expect(byType.BUY.user_id).toBe(pick.id);
  expect(byType.OPERATION.user_id).toBe(pick.id);
  // 公司位固定不绑人；售出位无 SELL 事件禁用不绑人，其 user_id 取订单交付负责人候选值，不单独断言。
  expect(byType.COMPANY.user_id).toBeNull();
});

// 重写入用例：串行隔离（describe.serial），避免与文件内其他写用例及 E2E 库写竞争
// 互相拖累；单跑 ~16s，全量曾贴 30s 超时边界偶发红，故显式 test.slow() 放宽。
test.describe.serial("重写入用例（串行隔离）", () => {
  test.slow();
  test("页面售出绑定操作人，返点登记后在返点明细可见", async ({ page, request }) => {
    // 库存台账路由已随表改名 accounts → stocks（迁移 0009），返回分页信封 { items, total }。
    const accountPaged = (await (
      await request.get(`${base}/stocks`, { headers })
    ).json()) as {
      items: Array<{
        inventory_type: string;
        inventory_status: string;
        game_account: string;
        source_order_id?: number | null;
      }>;
    };
    // 售出必须挂在「来源入库订单」上，故先取一个干净的 IN_STOCK 代挂账号，
    // 再为它建一张 DG 来源单（库存账号由此获得 source_order_id）。
    const account = accountPaged.items.find(
      (a) =>
        a.inventory_type === "CONSIGNMENT" &&
        a.inventory_status === "IN_STOCK" &&
        a.game_account &&
        !a.source_order_id,
    );
    expect(account, "缺少 IN_STOCK 且未关联订单的代挂账号").toBeTruthy();
    const sourceOrder = await request.post(`${base}/orders`, {
      headers,
      data: { order_type: "DG", account_id: account!.id, trade_date: "2026-10-17" },
    });
    expect(sourceOrder.status()).toBe(201);
    expect(account).toBeTruthy();
    const users = await (await request.get(`${base}/users`, { headers })).json();
    const admin = users.find((u: { username: string }) => u.username === "admin");
    expect(admin).toBeTruthy();
    await page.goto("/");
    await navItem(page, "业务中心").click();
    await page.getByRole("tab", { name: "库存中心" }).click();
    await page.getByLabel("搜索库存账号").fill(account.game_account);
    // 搜索为子串匹配：e2e_consignment_1 会同时命中 _1/_10/_11/_12，故必须用「精确单元格文本」
    // 定位目标行，否则 .first() 会点进按最新排序的 _12 等误匹配行。
    const targetRow = page
      .getByRole("row")
      .filter({ has: page.getByText(account.game_account, { exact: true }) })
      .first();
    await targetRow.getByRole("button", { name: "售出" }).click();
    // 代挂账号的售出弹窗标题为「售出代挂账号」（非回收/提号的「售出回收/提号账号」），用正则匹配。
    const saleModal = page.getByRole("dialog", { name: /售出.*账号/ });

    // 买家信息区块已改为直接录入「客户昵称」（不再有「选择已有客户」下拉）：
    // 后端按昵称复用/建档客户，买家挂到原买入单。
    const buyerName = `E2E买家-${Date.now()}`;
    await saleModal.getByLabel("客户昵称").fill(buyerName);
    // 「客户来源」为必填下拉（CustomerSourceFields），选首个预设项。
    // 等「恰好 1 个下拉可见」再点选项，避免上一个下拉关闭动画期间的残留下拉被误选。
    const openDropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    await saleModal
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("客户来源"))')
      .locator(".ant-select-selector")
      .click();
    await expect(openDropdown).toHaveCount(1, { timeout: 5000 });
    await openDropdown.first().locator(".ant-select-item-option").first().click();

    // 代挂账号金额字段：代码里 label 传「利润」，但 CfgItem 用字段配置覆盖，实际渲染的
    // label 是「售出金额」、placeholder 才是「请输入利润（代挂佣金）」（见失败快照 aria 树）。
    // 而「售出金额」又会被「售出金额（仅记录）」这一项同时命中，故用唯一 placeholder 精确定位。
    await saleModal.getByPlaceholder("请输入利润（代挂佣金）").fill("200");

    // 收款资金账户（pool_id）：代挂账号下该字段 label 为「资金账户」（回收/提号为「收款资金账户」）。
    // 用 CSS 选择器（与 finance-write-ui 同范式）定位该表单项的 .ant-select-selector，
    // 避免 getByLabel 在「资金账户」与帮助文案「资金账户：请选择…」之间误匹配。
    // 等「恰好 1 个下拉可见」再点选项，规避关闭动画期间的残留下拉。
    await saleModal
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("资金账户"))')
      .locator(".ant-select-selector")
      .click();
    const poolDropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
    await expect(poolDropdown).toHaveCount(1, { timeout: 5000 });
    await poolDropdown.first().locator(".ant-select-item-option", { hasText: "投资款荷包（HJ_INVEST）" }).first().click();

    // 口径：售出 = 在原买入单上登记 SELL 事件，不再新建订单，故只等待事件 POST。
    const saleResponse = page.waitForResponse(r => /\/orders\/\d+\/events$/.test(r.url()) && r.request().method() === "POST");
    await saleModal.getByRole("button", { name: "确认售出" }).click();
    const saleRes = await saleResponse;
    expect(saleRes.status()).toBe(201);
    // URL 形如 /api/v1/orders/<id>/events → 路径段 ["", "api", "v1", "orders", "<id>", "events"]。
    const orderId = Number(new URL(saleRes.url()).pathname.split("/")[4]);
    const detail = await (await request.get(`${base}/orders/${orderId}`, { headers })).json();
    // 库存统一口径：代挂（CONSIGNMENT）售出映射为 DG 订单类型。
    expect(detail.order_type).toBe("DG");
    const order = { id: orderId };
    const sell = detail.events.find((e: { event_type: string }) => e.event_type === "SELL");
    expect(sell.created_by ?? sell.operator).toBe("admin");
    const allocations = await request.put(`${base}/orders/${order.id}/profit-allocations`, { headers, data: { items: [
      { allocation_type: "BUY", role: "OWNER", allocation_rate: "25" },
      { allocation_type: "SELL", role: "OWNER", allocation_rate: "25" },
      { allocation_type: "OPERATION", user_id: admin.id, role: "OWNER", allocation_rate: "25" },
      { allocation_type: "COMPANY", role: "OWNER", allocation_rate: "25" },
    ] } });
    expect(allocations.status()).toBe(200);
    // 按动作分润（ACTION 模型）：四项比例合计 100% 落库即可。
    // SELL 动作位绑定「交付负责人」（delivery_responsible_ids，本表单默认值），
    // 并非建单操作人 admin，故只校验四项齐全、SELL 比例正确，不绑死具体 user_id。
    const savedAllocations = await allocations.json();
    expect(savedAllocations.items).toHaveLength(4);
    const sellAlloc = savedAllocations.items.find((a: { allocation_type: string }) => a.allocation_type === "SELL");
    expect(sellAlloc).toBeTruthy();
    expect(sellAlloc.allocation_rate).toBe("25.00");
    // 售出→返点建链：DG 订单可建 SELL 类型返点（rebates.py 要求 order_type==DG）。
    const rebateResponse = await request.post(`${base}/rebates`, { headers, data: { source_order_id: order.id, rebate_type: "SELL", base_amount: "100", rate: "0", collected_on: "2026-10-17" } });
    expect(rebateResponse.status()).toBe(201);
    const rebate = await rebateResponse.json();
    // 口径变更：返点结算模型已重构——DG 代挂沿用统一 SELL 事件登记卖出金额与利润，
    // 不再有独立「登记结算」流程，也不再生成 REBATE_FEE 手续费分录
    // （后端 /rebates/{id}/settlements 端点与 REBATE_FEE 类别均已移除）。
    // 故此处只验证：返点登记成功并在「返点明细」页签可见。
    await navItem(page, "资金中心").click();
    await page.getByRole("tab", { name: "返点明细" }).click();
    await expect(page.getByRole("row").filter({ hasText: rebate.rebate_no })).toBeVisible({ timeout: 10000 });
  });
});
