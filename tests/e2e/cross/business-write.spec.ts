import { test, expect } from "@playwright/test";

/** 严格业务契约的真实写入联调：不使用旧 account 兼容字段。 */
test("五类业务写入并按业务规则作废测试订单", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const accountsResponse = await request.get(`${apiBase}/stocks`, { headers });
  expect(accountsResponse.ok()).toBe(true);
  const accounts = (await accountsResponse.json()).items;
  const inStock = accounts.filter((item: { inventory_status: string }) => item.inventory_status === "IN_STOCK");
  const accountFor = (inventoryType: string) => {
    const account = inStock.find((item: { inventory_type?: string }) => item.inventory_type === inventoryType);
    expect(account, `缺少 ${inventoryType} 测试账号`).toBeTruthy();
    return account.id as number;
  };
  const cases = [
    { order_type: "HS", account_id: accountFor("RECOVERY") },
    { order_type: "TH", account_id: accountFor("PICKUP") },
    { order_type: "DG", account_id: accountFor("CONSIGNMENT") },
  ];
  const created: number[] = [];
  for (const payload of cases) {
    const response = await request.post(`${apiBase}/orders`, {
      headers,
      data: { ...payload, trade_date: "2026-10-17" },
    });
    expect(response.status(), `${payload.order_type} 建单失败`).toBe(201);
    const body = await response.json();
    expect(body.order_type).toBe(payload.order_type);
    if (payload.account_id) expect(body.account_id).toBe(payload.account_id);
    created.push(body.id);
  }
  for (const orderId of created) {
    const cancelled = await request.post(`${apiBase}/orders/${orderId}/cancel`, {
      headers,
      data: { reason: "E2E 测试清理" },
    });
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).status).toBe("CANCELLED");
  }
});

test("自营分期出售：买入、分期收款、结清后交付", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const accountsResponse = await request.get(`${apiBase}/stocks`, { headers });
  expect(accountsResponse.ok()).toBe(true);
  const accounts = (await accountsResponse.json()).items;
  const account = accounts.find(
    (item: { inventory_status: string; inventory_type?: string }) =>
      item.inventory_status === "IN_STOCK" && item.inventory_type === "RECOVERY",
  );
  expect(account, "缺少 RECOVERY 测试账号").toBeTruthy();

  const orderResponse = await request.post(`${apiBase}/orders`, {
    headers,
    data: { order_type: "HS", trade_date: "2026-10-17", account_id: account.id },
  });
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();

  const buyResponse = await request.post(`${apiBase}/orders/${order.id}/events`, {
    headers,
    data: { event_type: "BUY", amount: "1200.00", occurred_on: "2026-10-17" },
  });
  expect(buyResponse.status()).toBe(201);

  const installmentResponse = await request.post(`${apiBase}/installments`, {
    headers,
    data: {
      order_id: order.id,
      contract_type: "STOCK_SALE",
      principal: "1200.00",
      down_payment: "0.00",
      periods: 3,
      per_period: "400.00",
      first_due_on: "2026-10-17",
    },
  });
  expect(installmentResponse.status()).toBe(201);
  const installment = await installmentResponse.json();

  for (const period_no of [1, 2, 3]) {
    const payment = await request.post(`${apiBase}/installments/${installment.id}/payments`, {
      headers,
      data: { amount: "400.00", paid_on: "2026-10-17", period_no },
    });
    expect(payment.status(), `第 ${period_no} 期收款失败`).toBe(200);
  }
  const delivery = await request.post(`${apiBase}/installments/${installment.id}/deliver`, {
    headers,
    data: { delivery_mode: "PLATFORM_OPERATOR", delivered_on: "2026-10-17", note: "E2E 测试换绑凭证" },
  });
  expect(delivery.status()).toBe(200);
  expect((await delivery.json()).status).toBe("DELIVERED");
});

test("资金闭环：独立流水审核冲销、资金池划转与日对账", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const poolsResponse = await request.get(`${apiBase}/pools`, { headers });
  expect(poolsResponse.ok()).toBe(true);
  const pools = await poolsResponse.json();
  expect(pools.length).toBeGreaterThanOrEqual(2);
  const source = pools[0].id as number;
  const target = pools[1].id as number;

  const flow = await request.post(`${apiBase}/cashflows`, {
    headers,
    data: {
      pool_id: source,
      occurred_on: "2026-10-17",
      direction: "IN",
      nature: "EXTERNAL_IN",
      category: "E2E_TEST",
      amount: "10.00",
      note: "E2E 独立收款摘要",
    },
  });
  expect(flow.status()).toBe(201);
  const flowBody = await flow.json();
  // 口径：资金流水已取消审核/驳回流程，录入即入账（提交 3f7c115），创建即 APPROVED。
  expect(flowBody.status).toBe("APPROVED");

  const reversal = await request.post(`${apiBase}/cashflows/${flowBody.id}/reverse`, {
    headers,
    data: { reversed_on: "2026-10-17", reason: "E2E 冲销" },
  });
  expect(reversal.status()).toBe(200);
  expect((await reversal.json()).category).toBe("REVERSAL");

  const transfer = await request.post(`${apiBase}/transfers`, {
    headers,
    data: { source_pool_id: source, target_pool_id: target, amount: "1.00", occurred_on: "2026-10-17" },
  });
  expect(transfer.status()).toBe(201);
  expect((await transfer.json()).cashflows).toHaveLength(2);

  const reconciliation = await request.post(`${apiBase}/reconciliations`, {
    headers,
    data: { pool_id: source, reconciled_on: "2026-10-17", account_label: `E2E 账户-${Date.now()}`, statement_balance: "0.00", reason: "E2E 差异说明" },
  });
  expect(reconciliation.status()).toBe(201);
  const reconciliationBody = await reconciliation.json();
  const resolved = await request.post(`${apiBase}/reconciliations/${reconciliationBody.id}/resolve`, {
    headers,
    data: { reason: "E2E 核对完成" },
  });
  expect(resolved.status()).toBe(200);
  expect((await resolved.json()).status).toBe("RESOLVED");
});

test("客户需求池：新建、查询与转单", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const customerResponse = await request.post(`${apiBase}/customers`, {
    headers,
    data: { display_name: "E2E 需求客户", contact_name: "E2E", phone: "13900000000" },
  });
  expect(customerResponse.status()).toBe(201);
  const customer = (await customerResponse.json()).customer;
  const orderResponse = await request.post(`${apiBase}/orders`, { headers, data: { order_type: "DG", trade_date: "2026-10-17" } });
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  const created = await request.post(`${apiBase}/leads`, {
    headers,
    data: { customer_id: customer.id, request_type: "FIND_ACCOUNT", target: "E2E 指定账号", budget: "100.00" },
  });
  expect(created.status()).toBe(201);
  const lead = await created.json();
  const listed = await request.get(`${apiBase}/leads?status=OPEN`, { headers });
  expect(listed.ok()).toBe(true);
  expect((await listed.json()).some((item: { id: number }) => item.id === lead.id)).toBe(true);
  const converted = await request.post(`${apiBase}/leads/${lead.id}/convert`, { headers, data: { order_id: order.id } });
  expect(converted.status()).toBe(200);
  expect((await converted.json()).status).toBe("CONVERTED");
});

test("系统通知：查询当前用户的未读通知", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const listed = await request.get(`${apiBase}/notifications?unread_only=true`, { headers });
  expect(listed.status()).toBe(200);
  const body = await listed.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(typeof body.unread_total).toBe("number");
});

test("治理能力：报表导出与订单附件闭环", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const report = await request.get(`${apiBase}/reports/order-profit/export.csv`, { headers, params: { from: "2026-01-01", to: "2026-12-31" } });
  expect(report.status()).toBe(200);
  expect(report.headers()["content-type"]).toContain("text/csv");
  const orderResponse = await request.post(`${apiBase}/orders`, { headers, data: { order_type: "DG", trade_date: "2026-10-17" } });
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  const attachment = await request.post(`${apiBase}/attachments`, {
    headers,
    data: { entity_type: "order", entity_id: order.order_no, file_name: "e2e.txt", content_type: "text/plain", content_base64: "RTJFIEFUVEFDSA==" },
  });
  expect(attachment.status()).toBe(201);
  const attachmentBody = await attachment.json();
  const listed = await request.get(`${apiBase}/attachments`, { headers, params: { entity_type: "order", entity_id: order.order_no } });
  expect((await listed.json()).items.some((item: { id: number }) => item.id === attachmentBody.id)).toBe(true);
  const downloaded = await request.get(`${apiBase}/attachments/${attachmentBody.id}/download`, { headers });
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toBe("E2E ATTACH");
  const removed = await request.delete(`${apiBase}/attachments/${attachmentBody.id}`, { headers });
  expect(removed.status()).toBe(200);
});

test("主数据治理：业务类型路由影响预览", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const types = await request.get(`${apiBase}/order-types`, { headers });
  expect(types.ok()).toBe(true);
  const orderType = (await types.json()).find((item: { code: string }) => item.code === "HS");
  expect(orderType).toBeTruthy();
  const pools = await request.get(`${apiBase}/pools`, { headers });
  const pool = (await pools.json())[0];
  const preview = await request.get(`${apiBase}/order-types/${orderType.code}/routes/impact-preview`, { headers, params: { portion: "PRINCIPAL", pool_code: pool.code } });
  expect(preview.status()).toBe(200);
  expect((await preview.json()).future_effect).toBeTruthy();
});

test("治理权限：viewer 拒绝报表导出，审计可追溯业务操作", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const viewerExport = await request.get(`${apiBase}/reports/order-profit/export.csv`, { headers: { "X-Dev-User": "viewer" } });
  expect(viewerExport.status()).toBe(403);
  const adminAudit = await request.get(`${apiBase}/audit-logs`, { headers: { "X-Dev-User": "admin" }, params: { entity_type: "order", limit: 20 } });
  expect(adminAudit.status()).toBe(200);
  expect((await adminAudit.json()).items).toBeDefined();
});

test("数据范围：管理员可配置用户资金池范围", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const headers = { "X-Dev-User": "admin" };
  const pools = await request.get(`${apiBase}/pools`, { headers });
  const pool = (await pools.json())[0];
  const updated = await request.patch(`${apiBase}/users/2`, { headers, data: { owner_scope: "TEAM", pool_ids: [pool.id], team_ids: [] } });
  expect(updated.status()).toBe(200);
  const body = await updated.json();
  expect(body.owner_scope).toBe("TEAM");
  expect(body.pool_ids).toContain(pool.id);
});

test("数据范围：非管理员只能看到授权资金池", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
  const adminHeaders = { "X-Dev-User": "admin" };
  const pools = await request.get(`${apiBase}/pools`, { headers: adminHeaders });
  const poolList = await pools.json();
  expect(poolList.length).toBeGreaterThanOrEqual(2);
  const authorized = poolList[0].id as number;
  const update = await request.patch(`${apiBase}/users/2`, { headers: adminHeaders, data: { owner_scope: "TEAM", pool_ids: [authorized], team_ids: [] } });
  expect(update.status()).toBe(200);
  const scoped = await request.get(`${apiBase}/pools`, { headers: { "X-Dev-User": "operator" } });
  expect(scoped.status()).toBe(200);
  expect((await scoped.json()).every((pool: { id: number }) => pool.id === authorized)).toBe(true);
});
