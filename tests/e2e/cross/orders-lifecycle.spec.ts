import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { navItem } from "../support/api-stub";

/**
 * orders 包功能流 E2E（真实后端联调）。
 *
 * 对应 C 档「以功能为纲重构测试体系 → 先建 E2E 后降级契约」的第一步：
 * 用真实业务闭环（而非逐字段断言）守护 orders 的核心能力，待本文件稳定后，
 * tests/backend/integration/business/test_orders_contract.py 中的逐字段契约断言
 * 可降级为状态码 + 关键业务字段的冒烟级。
 *
 * 约定与 business-write.spec.ts 一致：直连 /api，X-Dev-User 头模拟用户，
 * 默认 http://127.0.0.1:8123，可由 ERP_E2E_API_BASE 覆盖。
 */
const apiBase = () => process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api";
const ADMIN = { "X-Dev-User": "admin" };
const TRADE_DATE = "2026-10-17";

test("工作台分润消息在弹窗打开后才已读", async ({ page, request }) => {
  const base = apiBase();
  const created = await request.post(`${base}/orders`, { headers: ADMIN, data: {
    order_type: "HS", trade_date: TRADE_DATE,
    account_snapshot: { game_account: `e2e-notification-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1], sell_delivery_responsible_ids: [1] },
  } });
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();
  for (const [eventType, amount] of [["BUY", "100.00"], ["SELL", "600.00"]]) {
    const response = await request.post(`${base}/orders/${order.id}/events`, { headers: ADMIN, data: {
      event_type: eventType, amount, occurred_on: TRADE_DATE, operator_user_ids: [1],
    } });
    expect(response.status(), await response.text()).toBe(201);
  }
  const inbox = async () => (await (await request.get(`${base}/notifications/inbox?category=sale&limit=50`, { headers: ADMIN })).json()).items as Array<{ id: number; entity_id: string; read_at: string | null }>;
  const notification = (await inbox()).find((item) => item.entity_id === order.order_no);
  expect(notification?.read_at).toBeNull();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/orders/${order.id}/profit-allocations`, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/#/workbench");
    await page.getByRole("tab", { name: "售出消息" }).click();
    await page.getByRole("button", { name: new RegExp(order.order_no) }).click();
    await expect(page).toHaveURL(/allocation_order_id=/);
    expect((await inbox()).find((item) => item.id === notification?.id)?.read_at).toBeNull();
  } finally {
    release();
  }
  await expect(page.getByRole("dialog", { name: `分润 · ${order.order_no}` })).toBeVisible();
  await expect.poll(async () => (await inbox()).find((item) => item.id === notification?.id)?.read_at).not.toBeNull();
});

test("手机横向滚动订单台账时保留订单号", async ({ page, request }) => {
  const base = apiBase();
  const created = await request.post(`${base}/orders`, { headers: ADMIN, data: {
    order_type: "HS", trade_date: TRADE_DATE,
    account_snapshot: { game_account: `e2e-mobile-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1] },
  } });
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#/business/ledger");
  await page.getByRole("searchbox", { name: "搜索订单" }).fill(order.order_no);
  await page.getByRole("button", { name: "执行订单搜索" }).click();
  const row = page.locator(".orders-ledger tbody tr").filter({ hasText: order.order_no }).first();
  await expect(row).toBeVisible();
  const identity = row.locator("td").filter({ hasText: order.order_no }).first();
  const expand = row.locator("td.ant-table-row-expand-icon-cell");
  await expect(identity).toHaveCSS("position", "sticky");
  await expect(expand).toHaveCSS("position", "static");
  const scroll = page.locator(".orders-ledger .ant-table-content");
  const moved = await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; return element.scrollLeft; });
  expect(moved).toBeGreaterThan(0);
  const left = await scroll.evaluate((element) => element.getBoundingClientRect().left);
  const identityLeft = await identity.evaluate((element) => element.getBoundingClientRect().left);
  expect(Math.abs(identityLeft - left)).toBeLessThan(3);
});

test("订单台账下架弹窗使用后端当前上架记录", async ({ page, request }) => {
  const base = apiBase();
  const created = await request.post(`${base}/orders`, { headers: ADMIN, data: {
    order_type: "DG", trade_date: TRADE_DATE,
    account_snapshot: { game_account: `e2e-consignment-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1] },
  } });
  expect(created.status(), await created.text()).toBe(201);
  const order = await created.json();
  const posted = await request.post(`${base}/orders/${order.id}/events`, { headers: ADMIN, data: {
    event_type: "OPERATE", operation_type: "CONSIGNMENT", occurred_on: TRADE_DATE,
    operator_user_ids: [1], form_extra: { consignment_platforms: ["千寻"], listed_at: `${TRADE_DATE}T10:00:00` },
  } });
  expect(posted.status(), await posted.text()).toBe(201);
  const detail = await request.get(`${base}/orders/${order.id}/execution-detail`, { headers: ADMIN });
  expect(detail.status()).toBe(200);
  expect((await detail.json()).orders[0].active_consignments.map((item: { platform: string }) => item.platform)).toEqual(["千寻"]);

  await page.goto("/#/business/ledger");
  await page.getByRole("searchbox", { name: "搜索订单" }).fill(order.order_no);
  await page.getByRole("button", { name: "执行订单搜索" }).click();
  const row = page.locator(".orders-ledger tbody tr").filter({ hasText: order.order_no }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "运营" }).click();
  await page.getByRole("menuitem", { name: "下架" }).click();
  await expect(page.getByRole("dialog", { name: "下架" }).getByText("千寻")).toBeVisible();
});

test("订单完整生命周期：建单→详情可见→编辑→取消并保留凭证", async ({ request }) => {
  const base = apiBase();

  // 建单
  const created = await request.post(`${base}/orders`, {
    headers: ADMIN,
    data: {
      order_type: "HS", trade_date: TRADE_DATE,
      account_snapshot: { game_account: `e2e-order-${Date.now()}`, game_type: "王者荣耀" },
      form_extra: { business_responsible_ids: [1] },
    },
  });
  expect(created.status(), "建单失败").toBe(201);
  const order = await created.json();
  expect(order.order_type).toBe("HS");

  // 详情可见
  const detail = await request.get(`${base}/orders/${order.id}`, { headers: ADMIN });
  expect(detail.status()).toBe(200);
  expect((await detail.json()).id).toBe(order.id);

  // 编辑备注
  const updated = await request.patch(`${base}/orders/${order.id}`, {
    headers: ADMIN,
    data: { note: "E2E 生命周期备注" },
  });
  expect(updated.status()).toBe(200);
  expect((await updated.json()).note).toBe("E2E 生命周期备注");

  // 取消
  const cancelled = await request.post(`${base}/orders/${order.id}/cancel`, {
    headers: ADMIN,
    data: { reason: "E2E 生命周期清理" },
  });
  expect(cancelled.status()).toBe(200);
  expect((await cancelled.json()).status).toBe("CANCELLED");

  // 取消后原凭证仍可查询，历史物理删除接口不可清除它。
  expect(
    (await request.delete(`${base}/orders/${order.id}`, { headers: ADMIN, data: { reason: "E2E 生命周期清理" } })).status(),
  ).toBe(422);
  const retained = await request.get(`${base}/orders/${order.id}`, { headers: ADMIN });
  expect(retained.status()).toBe(200);
  expect((await retained.json()).status).toBe("CANCELLED");
});

test("库存页面可选择导出可见列或完整明细", async ({ page, request }) => {
  const base = apiBase();
  const gameAccount = `e2e-export-${Date.now()}`;
  const created = await request.post(`${base}/orders`, { headers: ADMIN, data: {
    order_type: "HS", trade_date: TRADE_DATE,
    account_snapshot: { game_account: gameAccount, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1] },
  } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  const scopes = await (await request.get(`${base}/list-columns`, { headers: ADMIN })).json();
  const columns = scopes.find((scope: { code: string }) => scope.code === "INVENTORY").columns as Array<{ key: string; label: string; is_visible: boolean }>;
  const csvCell = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const expectedHeader = columns.filter((column) => column.is_visible && column.key !== "actions").map((column) => csvCell(column.label)).join(",");

  await page.goto("/");
  await navItem(page, "业务中心").click();
  await page.getByRole("searchbox", { name: "搜索库存账号" }).fill(gameAccount);
  await expect(page.getByText(gameAccount, { exact: true })).toBeVisible();
  const readDownload = async (choice: string) => {
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const download = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: choice }).click();
    const path = await (await download).path();
    if (!path) throw new Error("导出文件不可读取");
    return readFile(path, "utf8");
  };
  const visible = await readDownload("导出页面可见列");
  expect(visible.replace(/^\ufeff/, "").split(/\r?\n/)[0]).toBe(expectedHeader);
  const full = await readDownload("导出完整明细");
  expect(full).toContain("执行明细");
  expect(full).toContain(order.order_no);
});

test("分润比例即时换算并按最新利润保存", async ({ page, request }) => {
  const base = apiBase();
  const created = await request.post(`${base}/orders`, { headers: ADMIN, data: {
    order_type: "HS", trade_date: TRADE_DATE,
    account_snapshot: { game_account: `e2e-allocation-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1], sell_delivery_responsible_ids: [1] },
  } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  for (const [eventType, amount] of [["BUY", "100.00"], ["SELL", "600.00"]]) {
    const response = await request.post(`${base}/orders/${order.id}/events`, { headers: ADMIN, data: {
      event_type: eventType, amount, occurred_on: TRADE_DATE, operator_user_ids: [1],
    } });
    expect(response.status(), await response.text()).toBe(201);
  }
  const initial = await (await request.get(`${base}/orders/${order.id}/profit-allocations`, { headers: ADMIN })).json();
  expect(initial.order_profit).toBe("500.00");
  const companyRate = Number(initial.company_rate);
  const staffRate = 100 - companyRate;
  const fixed = (value: number) => value.toFixed(2);
  const initialItems = [
    { allocation_type: "BUY", employee_ids: [1], role: "BUYER", allocation_rate: "0" },
    { allocation_type: "SELL", employee_ids: [1], role: "SALES", allocation_rate: "0" },
    { allocation_type: "OPERATION", employee_ids: [1], role: "SERVICE", allocation_rate: fixed(staffRate) },
    { allocation_type: "COMPANY", employee_ids: [], role: "OWNER", allocation_rate: fixed(companyRate) },
  ];
  const seeded = await request.put(`${base}/orders/${order.id}/profit-allocations`, { headers: ADMIN, data: {
    items: initialItems, amounts_changed: false, rates_changed: true, expected_order_profit: "500.00",
  } });
  expect(seeded.status(), await seeded.text()).toBe(200);

  await page.goto("/#/business/ledger");
  await page.getByRole("searchbox", { name: "搜索订单" }).fill(order.order_no);
  const row = page.getByRole("row").filter({ hasText: order.order_no });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "分润配置" }).click();
  const dialog = page.getByRole("dialog", { name: `分润 · ${order.order_no}` });
  const rates = dialog.getByLabel("比例");
  const amounts = dialog.getByLabel("金额");
  const buyRate = Math.min(20, staffRate);
  await rates.nth(0).fill(fixed(buyRate));
  await expect(amounts.nth(0)).toHaveValue(fixed(500 * buyRate / 100));
  await rates.nth(2).fill(fixed(staffRate - buyRate));
  const saved = page.waitForResponse((response) => response.url().includes(`/orders/${order.id}/profit-allocations`) && response.request().method() === "PUT");
  await dialog.locator(".ant-modal-footer .ant-btn-primary").click();
  expect((await saved).status()).toBe(200);
  const final = await (await request.get(`${base}/orders/${order.id}/profit-allocations`, { headers: ADMIN })).json();
  expect(Number(final.totals_by_type.BUY.allocation_amount)).toBe(500 * buyRate / 100);
});

test("订单附件重复时可取消或确认继续上传", async ({ page, request }) => {
  const base = apiBase();
  const created = await request.post(`${base}/orders`, { headers: ADMIN, data: {
    order_type: "HS", trade_date: TRADE_DATE,
    account_snapshot: { game_account: `e2e-attachment-${Date.now()}`, game_type: "王者荣耀" },
    form_extra: { business_responsible_ids: [1] },
  } });
  expect(created.status()).toBe(201);
  const order = await created.json();
  await page.goto("/#/business/ledger");
  await page.getByRole("searchbox", { name: "搜索订单" }).fill(order.order_no);
  const row = page.getByRole("row").filter({ hasText: order.order_no });
  await expect(row).toBeVisible();
  await row.getByText(order.order_no, { exact: true }).click();
  await page.getByRole("button", { name: "查看订单附件" }).click();
  const file = { name: `凭证-${Date.now()}.txt`, mimeType: "text/plain", buffer: Buffer.from(`attachment-${Date.now()}`) };
  const input = page.getByLabel("上传订单附件");
  const firstUpload = page.waitForResponse((response) => response.url().endsWith("/attachments") && response.request().method() === "POST");
  await input.setInputFiles(file);
  expect((await firstUpload).status()).toBe(201);
  await expect(page.getByText(file.name, { exact: true })).toBeVisible();

  const duplicate = page.waitForResponse((response) => response.url().endsWith("/attachments") && response.request().method() === "POST");
  await input.setInputFiles(file);
  expect((await duplicate).status()).toBe(409);
  await expect(page.getByText(/已有相同内容的附件/)).toBeVisible();
  await page.getByRole("alert").getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByText(/已有相同内容的附件/)).not.toBeVisible();

  const duplicateAgain = page.waitForResponse((response) => response.url().endsWith("/attachments") && response.request().method() === "POST");
  await input.setInputFiles(file);
  expect((await duplicateAgain).status()).toBe(409);
  const confirmed = page.waitForResponse((response) => response.url().endsWith("/attachments") && response.request().method() === "POST");
  await page.getByRole("button", { name: "继续上传" }).click();
  expect((await confirmed).status()).toBe(201);
  const listed = await (await request.get(`${base}/attachments`, { headers: ADMIN, params: { entity_type: "order", entity_id: order.order_no } })).json();
  expect(listed.total).toBe(2);
});

test("经营中心切换我的收益和全员分润，导出遵循时序", async ({ page }) => {
  const mine = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/reports/commission") && url.searchParams.get("mine") === "true";
  });
  await page.goto("/#/operations?tab=my-earnings&period=all");
  expect((await mine).status()).toBe(200);
  const allPeople = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/reports/commission") && url.searchParams.get("all_people") === "true";
  });
  await page.getByText("全员分润", { exact: true }).click();
  expect((await allPeople).status()).toBe(200);
  await page.getByRole("button", { name: "最旧在前" }).click();
  const exported = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/reports/commission/export.csv") && url.searchParams.get("sort_desc") === "false";
  });
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const result = await exported;
  expect(result.status()).toBe(200);
  expect(new URL(result.url()).searchParams.get("all_people")).toBe("true");
});

