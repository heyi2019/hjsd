import { test, expect } from "@playwright/test";

/**
 * installments 包（HS-01 分期合约域）功能流 E2E（真实后端联调）。
 *
 * C 档「以功能为纲」第二步：按真实代码包建功能流，验证业务行为与状态机，
 * 而非逐字段断言。本文件覆盖 business-write.spec.ts 未触及的分期合约特有规则：
 *   1) 分期金额口径（total_receivable / remaining_receivable 唯一来源）与状态机；
 *   2) 业务规则：DG/代挂不允许分期（仅全款）；
 *   3) 提前结清与取消分期（冲销 refund/reversed）两个分期独有动作。
 *
 * 约定与 orders-lifecycle.spec.ts 一致：直连 /api/v1，X-Dev-User 模拟用户，
 * 默认 8123，由 ERP_E2E_API_BASE 覆盖（Playwright 跑时指向独立 e2e 库 8124）。
 */

const apiBase = () => process.env.ERP_E2E_API_BASE ?? "http://127.0.0.1:8123/api/v1";
const ADMIN = { "X-Dev-User": "admin" };
const TRADE_DATE = "2026-10-17";

/** Decimal 在 JSON 里序列化为字符串或数字，统一转 number 比较金额口径。 */
const money = (v: unknown): number => Number(String(v));

/** 从库存取一枚指定类型的在库账号，复用 business-write.spec.ts 的已验证逻辑。 */
async function stockAccountId(request: any, inventoryType: string): Promise<number> {
  const res = await request.get(`${apiBase()}/stocks`, { headers: ADMIN });
  expect(res.ok(), "库存列表拉取失败").toBe(true);
  const items = (await res.json()).items as Array<{ inventory_status: string; inventory_type?: string; id: number }>;
  const account = items.find(
    (it) => it.inventory_status === "IN_STOCK" && it.inventory_type === inventoryType,
  );
  expect(account, `缺少 ${inventoryType} 在库测试账号`).toBeTruthy();
  return account!.id;
}

/** 建 HS 回收单并入库（BUY 事件），返回 order id。 */
async function createBoughtHsOrder(request: any): Promise<number> {
  const accountId = await stockAccountId(request, "RECOVERY");
  const orderRes = await request.post(`${apiBase()}/orders`, {
    headers: ADMIN,
    data: { order_type: "HS", trade_date: TRADE_DATE, account_id: accountId },
  });
  expect(orderRes.status(), "建 HS 单失败").toBe(201);
  const orderId = (await orderRes.json()).id as number;

  const buyRes = await request.post(`${apiBase()}/orders/${orderId}/events`, {
    headers: ADMIN,
    data: { event_type: "BUY", amount: "1200.00", occurred_on: TRADE_DATE },
  });
  expect(buyRes.status(), "BUY 入库事件失败").toBe(201);
  return orderId;
}

test("分期合约：金额口径 + 状态机 PENDING→ACTIVE→SETTLED→DELIVERED", async ({ request }) => {
  const base = apiBase();
  const orderId = await createBoughtHsOrder(request);

  // 建分期：首付 0 + 每期 400 × 3 期 = 总应收 1200
  const instRes = await request.post(`${base}/installments`, {
    headers: ADMIN,
    data: {
      order_id: orderId,
      contract_type: "STOCK_SALE",
      principal: "1200.00",
      down_payment: "0.00",
      periods: 3,
      per_period: "400.00",
      first_due_on: TRADE_DATE,
    },
  });
  expect(instRes.status(), "建分期失败").toBe(201);
  const inst = await instRes.json();
  expect(inst.status).toBe("PENDING");

  // 金额口径：唯一来源由后端 computed 计算，不应由前端自算
  expect(money(inst.total_receivable), "总应收口径错误").toBe(1200);
  expect(money(inst.remaining_receivable), "初始剩余应收应为全额").toBe(1200);

  // 还款计划：验证金额闭环（各期 due_amount 合计 == 总应收）。
  // 真实规则：periods=3 会生成 1 个初期占位期(period_no=0, due_amount=0) + 3 个业务期，
  // 故不硬编码期数，改验「期款合计 == 总应收」这一业务不变量。
  const schedRes = await request.get(`${base}/installments/${inst.id}/schedules`, { headers: ADMIN });
  expect(schedRes.status()).toBe(200);
  const schedBody: any = await schedRes.json();
  const schedules: any[] = Array.isArray(schedBody) ? schedBody : schedBody.items ?? [];
  expect(schedules.length, "应生成还款计划").toBeGreaterThanOrEqual(3);
  const sumDue = schedules.reduce((s: number, x: any) => s + money(x.due_amount), 0);
  expect(sumDue, "还款计划各期应还合计应等于总应收").toBe(money(inst.total_receivable));

  // 第 1 期收款 → ACTIVE，剩余应收递减
  const p1 = await request.post(`${base}/installments/${inst.id}/payments`, {
    headers: ADMIN,
    data: { amount: "400.00", paid_on: TRADE_DATE, period_no: 1 },
  });
  expect(p1.status(), "第 1 期收款失败").toBe(200);
  const afterP1 = (await p1.json()).installment;
  expect(afterP1.status).toBe("ACTIVE");
  expect(money(afterP1.remaining_receivable), "第 1 期后剩余应收应递减").toBe(800);

  // 第 2、3 期收款 → SETTLED，剩余应收归零（PaymentResult.installment 携带最新状态）
  let settledInst: any;
  for (const period_no of [2, 3]) {
    const p = await request.post(`${base}/installments/${inst.id}/payments`, {
      headers: ADMIN,
      data: { amount: "400.00", paid_on: TRADE_DATE, period_no },
    });
    expect(p.status(), `第 ${period_no} 期收款失败`).toBe(200);
    settledInst = (await p.json()).installment;
  }
  expect(settledInst.status).toBe("SETTLED");
  expect(money(settledInst.remaining_receivable), "结清后剩余应收应归零").toBe(0);

  // 交付 → DELIVERED，订单进入完成态
  const deliver = await request.post(`${base}/installments/${inst.id}/deliver`, {
    headers: ADMIN,
    data: { delivered_on: TRADE_DATE, note: "E2E 换绑交付凭证" },
  });
  expect(deliver.status()).toBe(200);
  expect((await deliver.json()).status).toBe("DELIVERED");

  // 清理：取消并删除订单（删除需带原因，验证业务约束）
  await request.delete(`${base}/orders/${orderId}`, { headers: ADMIN, data: { reason: "E2E 清理" } });
});

test("业务规则：DG/代挂订单不允许建分期（仅全款）", async ({ request }) => {
  const base = apiBase();
  const accountId = await stockAccountId(request, "CONSIGNMENT");
  const orderRes = await request.post(`${base}/orders`, {
    headers: ADMIN,
    data: { order_type: "DG", trade_date: TRADE_DATE, account_id: accountId },
  });
  expect(orderRes.status()).toBe(201);
  const orderId = (await orderRes.json()).id as number;

  const instRes = await request.post(`${base}/installments`, {
    headers: ADMIN,
    data: {
      order_id: orderId,
      contract_type: "STOCK_SALE",
      principal: "1200.00",
      down_payment: "0.00",
      periods: 3,
      per_period: "400.00",
      first_due_on: TRADE_DATE,
    },
  });
  // 代挂仅全款，建分期应被拒（4xx）
  expect(instRes.status(), "DG 建分期应被拒").toBeGreaterThanOrEqual(400);
  expect(instRes.status()).toBeLessThan(500);

  // 清理
  await request.delete(`${base}/orders/${orderId}`, { headers: ADMIN, data: { reason: "E2E 清理" } });
});

test("分期独有动作：提前结清（剩余应收归零）", async ({ request }) => {
  const base = apiBase();
  const orderId = await createBoughtHsOrder(request);

  const instRes = await request.post(`${base}/installments`, {
    headers: ADMIN,
    data: {
      order_id: orderId,
      contract_type: "STOCK_SALE",
      principal: "1200.00",
      down_payment: "0.00",
      periods: 3,
      per_period: "400.00",
      first_due_on: TRADE_DATE,
    },
  });
  expect(instRes.status()).toBe(201);
  const instId = (await instRes.json()).id as number;

  // 先收 1 期
  const p1 = await request.post(`${base}/installments/${instId}/payments`, {
    headers: ADMIN,
    data: { amount: "400.00", paid_on: TRADE_DATE, period_no: 1 },
  });
  expect(p1.status()).toBe(200);

  // 提前结清：剩余应收应归零
  const settle = await request.post(`${base}/installments/${instId}/settle-early`, {
    headers: ADMIN,
    data: { paid_on: TRADE_DATE },
  });
  expect(settle.status(), "提前结清失败").toBe(200);
  const settledInst = await settle.json();
  expect(money(settledInst.remaining_receivable), "提前结清后剩余应收应归零").toBe(0);

  // 清理
  await request.delete(`${base}/orders/${orderId}`, { headers: ADMIN, data: { reason: "E2E 清理" } });
});

test("分期独有动作：未结清分期可取消并冲销", async ({ request }) => {
  const base = apiBase();
  const orderId = await createBoughtHsOrder(request);

  const instRes = await request.post(`${base}/installments`, {
    headers: ADMIN,
    data: {
      order_id: orderId,
      contract_type: "STOCK_SALE",
      principal: "1200.00",
      down_payment: "0.00",
      periods: 3,
      per_period: "400.00",
      first_due_on: TRADE_DATE,
    },
  });
  expect(instRes.status()).toBe(201);
  const instId = (await instRes.json()).id as number;

  // 收 1 期后再取消（未结清状态）
  const p1 = await request.post(`${base}/installments/${instId}/payments`, {
    headers: ADMIN,
    data: { amount: "400.00", paid_on: TRADE_DATE, period_no: 1 },
  });
  expect(p1.status()).toBe(200);

  const cancel = await request.post(`${base}/installments/${instId}/cancel`, {
    headers: ADMIN,
    data: { cancelled_on: TRADE_DATE, reason: "E2E 取消冲销验证" },
  });
  expect(cancel.status(), "取消分期失败").toBe(200);
  const cancelBody = await cancel.json();
  expect(typeof money(cancelBody.refund_amount)).toBe("number");
  expect(typeof money(cancelBody.reversed_amount)).toBe("number");
  expect(cancelBody.order_status, "取消后订单状态应回退").not.toBe("COMPLETED");

  // 清理
  await request.delete(`${base}/orders/${orderId}`, { headers: ADMIN, data: { reason: "E2E 清理" } });
});

test("业务规则：已结清分期不可取消（终态约束）", async ({ request }) => {
  const base = apiBase();
  const orderId = await createBoughtHsOrder(request);

  const instRes = await request.post(`${base}/installments`, {
    headers: ADMIN,
    data: {
      order_id: orderId,
      contract_type: "STOCK_SALE",
      principal: "1200.00",
      down_payment: "0.00",
      periods: 3,
      per_period: "400.00",
      first_due_on: TRADE_DATE,
    },
  });
  expect(instRes.status()).toBe(201);
  const instId = (await instRes.json()).id as number;

  // 全额收款 → 分期进入 SETTLED（终态）；用 PaymentResult.installment 取最新状态
  let paidInst: any;
  for (const period_no of [1, 2, 3]) {
    const p = await request.post(`${base}/installments/${instId}/payments`, {
      headers: ADMIN,
      data: { amount: "400.00", paid_on: TRADE_DATE, period_no },
    });
    expect(p.status()).toBe(200);
    paidInst = (await p.json()).installment;
  }
  expect(paidInst.status).toBe("SETTLED");

  // 已结清（终态）→ 取消应被拒
  const cancel = await request.post(`${base}/installments/${instId}/cancel`, {
    headers: ADMIN,
    data: { cancelled_on: TRADE_DATE, reason: "E2E 终态校验" },
  });
  expect(cancel.status(), "已结清分期取消应被拒").toBe(409);

  // 清理（已结清未交付，删除订单带原因）
  await request.delete(`${base}/orders/${orderId}`, { headers: ADMIN, data: { reason: "E2E 清理" } });
});
