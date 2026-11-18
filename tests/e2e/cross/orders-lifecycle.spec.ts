import { test, expect } from "@playwright/test";

/**
 * orders 包功能流 E2E（真实后端联调）。
 *
 * 对应 C 档「以功能为纲重构测试体系 → 先建 E2E 后降级契约」的第一步：
 * 用真实业务闭环（而非逐字段断言）守护 orders 的核心能力，待本文件稳定后，
 * tests/backend/integration/business/test_orders_contract.py 中的逐字段契约断言
 * 可降级为状态码 + 关键业务字段的冒烟级。
 *
 * 约定与 business-write.spec.ts 一致：直连 /api/v1，X-Dev-User 头模拟用户，
 * 默认 http://127.0.0.1:8123，可由 ERP_E2E_API_BASE 覆盖。
 */
const apiBase = () => process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
const ADMIN = { "X-Dev-User": "admin" };
const TRADE_DATE = "2026-10-17";

test("订单完整生命周期：建单→详情可见→编辑→取消→删除", async ({ request }) => {
  const base = apiBase();

  // 建单
  const created = await request.post(`${base}/orders`, {
    headers: ADMIN,
    data: { order_type: "HS", trade_date: TRADE_DATE },
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

  // 关联另一张订单
  const other = await request.post(`${base}/orders`, {
    headers: ADMIN,
    data: { order_type: "DG", trade_date: TRADE_DATE },
  });
  expect(other.status()).toBe(201);
  const otherId = (await other.json()).id;

  // 取消
  const cancelled = await request.post(`${base}/orders/${order.id}/cancel`, {
    headers: ADMIN,
    data: { reason: "E2E 生命周期清理" },
  });
  expect(cancelled.status()).toBe(200);
  expect((await cancelled.json()).status).toBe("CANCELLED");

  // 删除（需带原因：验证「删除订单必须说明缘由」的业务约束）
  expect(
    (await request.delete(`${base}/orders/${order.id}`, { headers: ADMIN, data: { reason: "E2E 生命周期清理" } })).status(),
  ).toBe(204);
  expect(
    (await request.delete(`${base}/orders/${otherId}`, { headers: ADMIN, data: { reason: "E2E 生命周期清理" } })).status(),
  ).toBe(204);
});

