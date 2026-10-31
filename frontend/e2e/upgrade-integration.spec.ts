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
  const row = page.getByRole("row").filter({ hasText: order.order_no });
  // 订单台账已改为行内「更多⌄」菜单直接操作（原「查看详情」抽屉已删除，提交 02d5f07）。
  // 菜单项口径：「登记退款」已更名「资金收支」（OrdersPage 行内菜单 key=refund）。
  await row.getByRole("button", { name: /更多/ }).click();
  await page.getByRole("menuitem", { name: "资金收支" }).click();
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

test("分润页面按人模型保存四项比例", async ({ page, request }) => {
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

  // 分润弹窗已重构为「按人」模型（OrdersPage.openAllocations）：顶部「姓名（可多选，勾选后自动加行）」
  // 勾选分润对象→自动加行，不再有 BUY/SELL/OPERATION/COMPANY 四个动作位，后端按人存
  // allocation_type=None 且禁止同一人重复分润。这里拉取在职用户，勾选 4 人凑满四项比例。
  const users = (await (await request.get(`${base}/users`, { headers })).json()) as Array<{ id: number; username: string; is_active: boolean }>;
  const pick = users.filter((u) => u.is_active).slice(0, 4);
  const pickIds = pick.map((u) => u.id);
  const pickUsernames = pick.map((u) => u.username);
  expect(pickIds.length).toBe(4);

  await page.goto("/");
  await navItem(page, "业务中心").click();
  // 业务中心默认落 URL 指定的 Tab（导航进来是 #/business/inventory 库存中心），
  // 「搜索订单」只在「订单台账」面板内，必须先切 Tab。
  await page.getByRole("tab", { name: "订单台账" }).click();
  await page.getByLabel("搜索订单").fill(order.order_no);
  // 「分润」收在行内「更多⌄」下拉菜单内（原「查看详情」抽屉已删除，提交 02d5f07）。
  await page
    .getByRole("row")
    .filter({ hasText: order.order_no })
    .getByRole("button", { name: /更多/ })
    .click();
  await page.getByRole("menuitem", { name: "分润" }).click();
  const modal = page.locator(".ant-modal-content");
  // Fix #4 改名验证：弹窗标题已为「分润 ·」。
  await expect(modal.getByText("分润 ·", { exact: false })).toBeVisible();

  // 分润弹窗现为「每行一位员工」的 Form.List（原顶部「多选姓名自动加行」模型已移除）：
  // 默认 1 行，点「+ 增加一行」凑到 4 行，逐行选员工并填 25% 比例（纯比例合计须 100%）。
  const rows = modal.locator(".orders-allocation-row");
  // 每点一次 Form.List 会重渲染整块（按钮节点被替换 → 出现 detached 重试），
  // 故每次重新定位按钮，并等行数按 2→3→4 增长后再点下一次。
  for (let target = 2; target <= 4; target += 1) {
    await modal.getByRole("button", { name: /增加一行/ }).click();
    await expect(rows).toHaveCount(target);
  }
  // 分两步：先逐行选员工（选中会触发该行重渲染，早填比例会被重置），再统一填比例。
  for (let i = 0; i < 4; i += 1) {
    await rows
      .nth(i)
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("姓名")) .ant-select-selector')
      .click();
    const dropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").last();
    await dropdown.locator(".ant-select-item-option", { hasText: pickUsernames[i] }).first().click();
  }
  for (let i = 0; i < 4; i += 1) {
    await rows
      .nth(i)
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("比例")) input')
      .fill("25");
  }

  const response = page.waitForResponse(
    (r) => r.url().endsWith(`/orders/${order.id}/profit-allocations`) && r.request().method() === "PUT",
  );
  await modal.getByRole("button", { name: /确\s*定/ }).click();
  expect((await response).status()).toBe(200);
  const saved = await (await request.get(`${base}/orders/${order.id}/profit-allocations`, { headers })).json();
  expect(saved.items).toHaveLength(4);
  // 按人模型：4 行均为真实 user_id（无 COMPANY 空归属），顺序不保证，按 id 集合断言。
  const savedUserIds = saved.items
    .map((x: { user_id: number | null }) => x.user_id)
    .filter((id: number | null): id is number => id !== null)
    .sort((a: number, b: number) => a - b);
  expect(savedUserIds).toEqual([...pickIds].sort((a: number, b: number) => a - b));
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
    await page.getByRole("row").filter({ hasText: account.game_account }).getByRole("button", { name: "售出" }).click();
    const saleModal = page.getByRole("dialog", { name: "售出账号" });

    // 买家信息区块已改为直接录入「客户昵称」（不再有「选择已有客户」下拉）：
    // 后端按昵称复用/建档客户，买家挂到原买入单。
    const buyerName = `E2E买家-${Date.now()}`;
    await saleModal.getByLabel("客户昵称").fill(buyerName);
    // 「客户来源」为必填下拉（CustomerSourceFields），选首个预设项。
    await saleModal
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("客户来源"))')
      .locator(".ant-select-selector")
      .click();
    await page
      .locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")
      .first()
      .click();

    // 「售出金额」与「售出金额2」（分笔进不同资金池）label 前缀相同，必须精确匹配。
    await saleModal.getByLabel("售出金额", { exact: true }).fill("200");

    // 收款资金账户（pool_id）：按表单 label 精确匹配（仅 FULL 付款方式下渲染）。
    await saleModal
      .locator('.ant-form-item:has(.ant-form-item-label:has-text("收款资金账户"))')
      .locator(".ant-select-selector")
      .click();
    const poolDropdown = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)").first();
    await poolDropdown.locator(".ant-select-item-option", { hasText: "投资款荷包（HJ_INVEST）" }).first().click();

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
    expect((await allocations.json()).items.find((a: { allocation_type: string }) => a.allocation_type === "SELL").user_id).toBe(admin.id);
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
