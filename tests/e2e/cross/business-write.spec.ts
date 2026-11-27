import { test, expect } from "@playwright/test";
import { navItem } from "../support/api-stub";

test("设置中下载订单模板并预检导入，重复订单可跳过", async ({ page, request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8124/api";
  const headers = { "X-Dev-User": "admin" };
  const sequences = await (await request.get(`${apiBase}/sequences`, { headers })).json();
  const number = sequences.find((item: { prefix: string }) => item.prefix === "DG")?.next_number as string;
  expect(number).toMatch(/^DG\d{4}$/);
  const currentUser = await (await request.get(`${apiBase}/auth/me`, { headers })).json();
  expect(currentUser.id).toBeGreaterThan(0);
  expect(currentUser.username).toBeTruthy();

  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "订单导入" }).click();
  await page.getByRole("radio", { name: "带详情导入" }).check();
  await page.getByRole("checkbox", { name: "操作明细" }).click();
  await expect(page.getByRole("checkbox", { name: "操作明细" })).toBeChecked();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载导入模板" }).click();
  expect((await download).suggestedFilename()).toBe("订单导入模板.xlsx");
  await page.getByRole("radio", { name: "台账展示列" }).check();
  await page.getByLabel("选择订单文件").setInputFiles({
    name: "历史订单.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`订单号,业务日期,业务类型,入库操作人,游戏账号/产品,订单备注\n${number},2026-10-17,代挂,${currentUser.username},导入测试账号,导入联调\n`),
  });
  await page.getByRole("button", { name: "预检文件" }).click();
  await expect(page.getByRole("row").filter({ hasText: number })).toContainText("新建");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText(/导入完成：新建 1，更新 0，跳过 0/)).toBeVisible();
  const list = await (await request.get(`${apiBase}/orders`, { headers, params: { keyword: number } })).json();
  const order = list.items.find((item: { order_no: string }) => item.order_no === number);
  expect(order.account_id).toBeNull();
  const detail = await (await request.get(`${apiBase}/orders/${order.id}`, { headers })).json();
  expect(detail.account_snapshot.game_account).toBe("导入测试账号");
  expect(detail.form_extra.business_responsible_ids).toEqual([currentUser.id]);
  expect(detail.note).toBe("导入联调");

  await page.getByRole("button", { name: "预检文件" }).click();
  await expect(page.getByRole("row").filter({ hasText: number })).toContainText("跳过");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByText(/导入完成：新建 0，更新 0，跳过 1/)).toBeVisible();
});

/** 严格业务契约的真实写入联调：不使用旧 account 兼容字段。 */
test("三类业务建单并按业务规则取消", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const created: number[] = [];
  for (const orderType of ["HS", "TH", "DG"]) {
    const response = await request.post(`${apiBase}/orders`, {
      headers,
      data: { order_type: orderType, trade_date: "2026-10-17",
        account_snapshot: { game_account: `e2e-${orderType}-${Date.now()}`, game_type: "王者荣耀" },
        form_extra: { business_responsible_ids: [1] } },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = await response.json();
    expect(body.order_type).toBe(orderType);
    expect(body.account_id).toBeTruthy();
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

test("资金闭环：独立流水冲销、资金账户划转与日对账", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
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
      category: "E2E_TEST",
      amount: "10.00",
      note: "E2E 独立收款摘要",
    },
  });
  expect(flow.status()).toBe(201);
  const flowBody = await flow.json();
  expect(flowBody.direction).toBe("IN");
  expect(Number(flowBody.amount)).toBe(10);

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
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const customerResponse = await request.post(`${apiBase}/customers`, {
    headers,
    data: { display_name: "E2E 需求客户", contact_name: "E2E", phone: "13900000000" },
  });
  expect(customerResponse.status()).toBe(201);
  const customer = (await customerResponse.json()).customer;
  const orderResponse = await request.post(`${apiBase}/orders`, { headers, data: { order_type: "DG", trade_date: "2026-10-17", form_extra: { business_responsible_ids: [1] } } });
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
  const converted = await request.post(`${apiBase}/leads/${lead.id}/convert`, { headers, data: { order_no: order.order_no } });
  expect(converted.status()).toBe(200);
  expect((await converted.json()).status).toBe("CONVERTED");
});

test("客户需求页面关闭和转单与后端状态一致", async ({ page, request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const customerName = `E2E 客户需求 ${Date.now()}`;
  const customerResponse = await request.post(`${apiBase}/customers`, { headers, data: { display_name: customerName } });
  expect(customerResponse.status(), await customerResponse.text()).toBe(201);
  const customer = (await customerResponse.json()).customer;
  const orderResponse = await request.post(`${apiBase}/orders`, { headers, data: { order_type: "DG", trade_date: "2026-10-17", form_extra: { business_responsible_ids: [1] } } });
  expect(orderResponse.status(), await orderResponse.text()).toBe(201);
  const order = await orderResponse.json();
  const leads = [];
  for (const target of ["关闭需求", "转单需求"]) {
    const response = await request.post(`${apiBase}/leads`, { headers, data: { customer_id: customer.id, request_type: "FIND_ACCOUNT", target } });
    expect(response.status(), await response.text()).toBe(201);
    leads.push(await response.json());
  }
  const convertFields = await (await request.get(`${apiBase}/order-form-fields`, { headers, params: { order_type_code: "LEADCONVERT" } })).json();
  const orderLabel = convertFields.find((field: { field_key: string }) => field.field_key === "order_id")?.label ?? "订单编号";

  await page.goto("/");
  await navItem(page, "客户中心").click();
  await page.getByRole("tab", { name: "客户需求池" }).click();
  const search = page.getByRole("searchbox", { name: "搜索客户需求" });
  await search.fill(customerName);
  await search.press("Enter");
  const closeRow = page.locator("tr").filter({ hasText: leads[0].lead_no });
  await expect(closeRow).toBeVisible();
  await closeRow.getByRole("button", { name: "关闭", exact: true }).click();
  let modal = page.getByRole("dialog", { name: "关闭客户需求" });
  await modal.getByLabel("关闭原因").fill("未提交的草稿");
  await modal.getByRole("button", { name: "取消" }).click();
  await closeRow.getByRole("button", { name: "关闭", exact: true }).click();
  modal = page.getByRole("dialog", { name: "关闭客户需求" });
  await expect(modal.getByLabel("关闭原因")).toHaveValue("");
  await modal.getByLabel("关闭原因").fill("客户已确认结束");
  await modal.getByRole("button", { name: "确认关闭" }).click();
  await expect(modal).toBeHidden();
  const closed = await (await request.get(`${apiBase}/leads/${leads[0].id}`, { headers })).json();
  expect(closed.status).toBe("CLOSED");
  expect(closed.closed_reason).toBe("客户已确认结束");

  const convertRow = page.locator("tr").filter({ hasText: leads[1].lead_no });
  await expect(convertRow).toBeVisible();
  await convertRow.getByRole("button", { name: "转单" }).click();
  const convertModal = page.getByRole("dialog", { name: "需求转单" });
  await convertModal.getByLabel(orderLabel).fill(order.order_no);
  await convertModal.getByRole("button", { name: "确认转单" }).click();
  await expect(convertModal).toBeHidden();
  const converted = await (await request.get(`${apiBase}/leads/${leads[1].id}`, { headers })).json();
  expect(converted.status).toBe("CONVERTED");
  expect(converted.converted_order_id).toBe(order.id);
});

test("系统通知：查询当前用户的未读通知", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const listed = await request.get(`${apiBase}/notifications/inbox?category=latest`, { headers });
  expect(listed.status()).toBe(200);
  const body = await listed.json();
  expect(Array.isArray(body.items)).toBe(true);
  expect(body.next_cursor === null || typeof body.next_cursor === "string").toBe(true);
});

test("治理能力：报表导出与订单附件闭环", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const report = await request.get(`${apiBase}/reports/order-profit/export.csv`, { headers, params: { from: "2026-01-01", to: "2026-12-31" } });
  expect(report.status()).toBe(200);
  expect(report.headers()["content-type"]).toContain("text/csv");
  const orderResponse = await request.post(`${apiBase}/orders`, { headers, data: { order_type: "DG", trade_date: "2026-10-17", form_extra: { business_responsible_ids: [1] } } });
  expect(orderResponse.status()).toBe(201);
  const order = await orderResponse.json();
  const attachmentContent = `E2E ATTACH ${order.order_no} ${Date.now()}`;
  const attachment = await request.post(`${apiBase}/attachments`, {
    headers,
    data: { entity_type: "order", entity_id: order.order_no, file_name: "e2e.txt", content_type: "text/plain", content_base64: Buffer.from(attachmentContent).toString("base64") },
  });
  expect(attachment.status()).toBe(201);
  const attachmentBody = await attachment.json();
  const listed = await request.get(`${apiBase}/attachments`, { headers, params: { entity_type: "order", entity_id: order.order_no } });
  expect((await listed.json()).items.some((item: { id: number }) => item.id === attachmentBody.id)).toBe(true);
  const downloaded = await request.get(`${apiBase}/attachments/${attachmentBody.id}/download`, { headers });
  expect(downloaded.status()).toBe(200);
  expect(await downloaded.text()).toBe(attachmentContent);
  const removed = await request.delete(`${apiBase}/attachments/${attachmentBody.id}`, { headers });
  expect(removed.status()).toBe(200);
});

test("主数据治理：业务类型零本金标记可见", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const headers = { "X-Dev-User": "admin" };
  const types = await request.get(`${apiBase}/order-types`, { headers });
  expect(types.ok()).toBe(true);
  const orderTypes = await types.json();
  expect(orderTypes.find((item: { code: string }) => item.code === "HS")?.is_zero_principal).toBe(false);
  expect(orderTypes.find((item: { code: string }) => item.code === "DG")?.is_zero_principal).toBe(true);
});

test("治理权限：viewer 拒绝报表导出，审计可追溯业务操作", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const viewerExport = await request.get(`${apiBase}/reports/order-profit/export.csv`, { headers: { "X-Dev-User": "viewer" } });
  expect(viewerExport.status()).toBe(403);
  const adminHeaders = { "X-Dev-User": "admin" };
  const created = await request.post(`${apiBase}/orders`, { headers: adminHeaders, data: { order_type: "DG", trade_date: "2026-10-17", form_extra: { business_responsible_ids: [1] } } });
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();
  const adminAudit = await request.get(`${apiBase}/audit-logs`, { headers: adminHeaders, params: { entity_type: "order", entity_id: order.order_no, action: "ORDER_CREATE" } });
  expect(adminAudit.status()).toBe(200);
  expect((await adminAudit.json()).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ entity_type: "order", entity_id: order.order_no, action: "ORDER_CREATE" }),
  ]));
});

test("数据范围：非管理员只能看到授权资金账户", async ({ request }) => {
  const apiBase = process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
  const adminHeaders = { "X-Dev-User": "admin" };
  const pools = await request.get(`${apiBase}/pools`, { headers: adminHeaders });
  expect(pools.status()).toBe(200);
  const poolList = await pools.json();
  expect(poolList.length).toBeGreaterThanOrEqual(2);
  const authorized = poolList[0].id as number;

  const username = `e2e_pool_scope_${Date.now()}`;
  const password = "temporary-pool-scope-123";
  const created = await request.post(`${apiBase}/users`, {
    headers: adminHeaders,
    data: { username, display_name: "E2E 资金范围测试", password, role: "OPERATOR", owner_scope: "SELF" },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const login = await request.post(`${apiBase}/auth/login`, { data: { username, password } });
  expect(login.status()).toBe(200);
  const changed = await request.post(`${apiBase}/auth/change-password`, {
    headers: { Authorization: `Bearer ${(await login.json()).access_token}` },
    data: { old_password: password, new_password: "updated-pool-scope-123" },
  });
  expect(changed.status()).toBe(200);
  const headers = { Authorization: `Bearer ${(await changed.json()).access_token}` };

  const unscoped = await request.get(`${apiBase}/pools`, { headers });
  expect(unscoped.status()).toBe(200);
  expect(await unscoped.json()).toEqual([]);
  const update = await request.patch(`${apiBase}/users/${id}`, {
    headers: adminHeaders,
    data: { owner_scope: "TEAM", pool_ids: [authorized], team_ids: [] },
  });
  expect(update.status()).toBe(200);
  expect(await update.json()).toMatchObject({ owner_scope: "TEAM", pool_ids: [authorized] });
  const scoped = await request.get(`${apiBase}/pools`, { headers });
  expect(scoped.status()).toBe(200);
  expect((await scoped.json()).map((pool: { id: number }) => pool.id)).toEqual([authorized]);
});


test("建单流程：关闭未保存表单时可继续编辑或确认放弃", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const mainModal = page.locator(".business-registration-modal");
  // 确认框是独立 portal，用其 Modal 类定位；关闭动画期间仍在 DOM，故以可见性判定。
  const confirm = page.locator(".heijin-fast-confirm");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /^(凌晨好|上午好|中午好|晚上好)，.+$/ })).toBeVisible();

  await page.getByText("自营·回收").first().click();
  await expect(mainModal).toBeVisible();
  await expect(page.getByText("新建回收订单")).toBeVisible();

  // 制造脏值：不填值时点关闭是直接关，不会弹确认框。
  // 必须填「真的注册在 Form 上的字段」——弹窗首个 input 可能是下拉框内嵌的
  // search/readonly 输入，填它不会进 form 值，dirty 判定为 false，也就不会弹确认框。
  const accountInput = mainModal
    .locator('.ant-form-item:has(.ant-form-item-label:has-text("游戏账号"))')
    .locator("input")
    .first();
  await accountInput.fill("E2E·放弃确认");
  await expect(accountInput).toHaveValue("E2E·放弃确认");

  // ① 点确认框 X：确认框收起，回到表单继续编辑。
  await mainModal.locator(".ant-modal-close").first().click();
  await expect(confirm).toBeVisible();
  await confirm.locator(".ant-modal-close").click();
  await expect(confirm).toBeHidden();
  await expect(mainModal).toBeVisible();

  // ② 点「继续编辑」：同上，且不触发 onClose。
  await mainModal.locator(".ant-modal-close").first().click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "继续编辑" }).click();
  await expect(confirm).toBeHidden();
  await expect(mainModal).toBeVisible();

  // ③ 点「放弃」：确认框与主弹窗必须同时消失，不得残留可见确认框。
  //    注：antd 会给双字按钮插空格（「放 弃」），故用正则而非精确名。
  await mainModal.locator(".ant-modal-close").first().click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /放\s*弃/ }).click();
  await expect(confirm).toBeHidden();
  await expect(mainModal).toBeHidden();

  // 收尾：重新打开不得带出上一个确认框。
  await page.getByText("自营·回收").first().click();
  await expect(mainModal).toBeVisible();
  await expect(confirm).toBeHidden();

  expect(errors).toEqual([]);
});
