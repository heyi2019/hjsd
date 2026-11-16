import { describe, expect, it } from "vitest";
import type { Order } from "@/shared/api/types/orders";
import {
  buildActionAllocationRows,
  filterBusinessOrders,
  formatOrderAmount,
} from "@/orders/orderpage/helpers";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  capital_type: "SELF",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  ...overrides,
});

describe("OrdersPage helpers", () => {
  it("按业务类型、模式、游戏和库存状态筛选订单", () => {
    expect(filterBusinessOrders([
      order({ account_game_type: "原神", account_status: "WAITING" }),
      order({ id: 2, order_no: "DG-2026-0002", order_type: "DG", business_mode: "DISTRIBUTION" }),
    ], "HS", "SELF", "原神", "原神", "WAITING")).toHaveLength(1);
  });

  it("格式化订单售出金额，不把买入金额混进来", () => {
    expect(formatOrderAmount(order({ sale_amount: "1500.00" }))).toBe("¥1,500.00");
    expect(formatOrderAmount(order({ sale_amount: null }))).toBe("-");
  });

  it("台账给买号新增执行人时，已存分润联动均分（1 人 → 2 人）", () => {
    // 存量：买号只有 1 人，比例 100、金额 30。
    const rows = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "20", allocation_amount: "6" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "30", allocation_amount: "9" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "50", allocation_amount: "15" },
    ], { BUY: [1, 2], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "20.00", allocation_amount: "6.00" },
      OPERATION: { allocation_rate: "30.00", allocation_amount: "9.00" },
      COMPANY: { allocation_rate: "50.00", allocation_amount: "15.00" },
    });

    const buyRows = rows.filter((row) => row.allocation_type === "BUY");
    // 新增的执行人直接进入同一行的多选框，比例/金额保持动作合计。
    expect(buyRows).toEqual([expect.objectContaining({ employee_ids: [1, 2], allocation_rate: "100.00", allocation_amount: "30.00" })]);
    const sellRows = rows.filter((row) => row.allocation_type === "SELL");
    expect(sellRows).toEqual([expect.objectContaining({ employee_ids: [4], allocation_rate: "20.00", allocation_amount: "6.00" })]);
    expect(rows.filter((row) => row.allocation_type === "COMPANY")).toHaveLength(1);
  });

  it("台账新增执行人后保留动作合计，均分由后端处理", () => {
    // 只填金额的单（比例留空），台账给买号新增到 3 人；前端只保留合计和人员。
    const rows = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "", allocation_amount: "0" },
    ], { BUY: [1, 2, 3], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "0.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "0.00", allocation_amount: "0.00" },
      OPERATION: { allocation_rate: "0.00", allocation_amount: "0.00" },
      COMPANY: { allocation_rate: "0.00", allocation_amount: "0.00" },
    });
    expect(rows.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [1, 2, 3], allocation_rate: "0.00", allocation_amount: "30.00" }),
    ]);
  });

  it("台账执行人与存量一致时合并为一行；台账换人后份额并入合计，候选为空时保留存量人员", () => {
    const same = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "60", allocation_amount: "18" },
      { allocation_type: "BUY", user_id: 2, role: "BUYER", allocation_rate: "40", allocation_amount: "12" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "0", allocation_amount: "0" },
    ], { BUY: [1, 2], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "0.00", allocation_amount: "0.00" },
      OPERATION: { allocation_rate: "0.00", allocation_amount: "0.00" },
      COMPANY: { allocation_rate: "0.00", allocation_amount: "0.00" },
    });
    expect(same.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [1, 2], allocation_rate: "100.00", allocation_amount: "30.00" }),
    ]);

    // 台账把买号从 1 换成 3：1 已不是该动作执行人（后端会拒绝非执行人收益人），
    // 份额并入合计后只留 3 一行；金额合计仍是 30，不凭空增删钱。
    const replaced = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
      { allocation_type: "SELL", user_id: 4, role: "SALES", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "OPERATION", user_id: 5, role: "SERVICE", allocation_rate: "0", allocation_amount: "0" },
      { allocation_type: "COMPANY", user_id: null, role: "OWNER", allocation_rate: "0", allocation_amount: "0" },
    ], { BUY: [3], SELL: [4], OPERATION: [5], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
      SELL: { allocation_rate: "0.00", allocation_amount: "0.00" },
      OPERATION: { allocation_rate: "0.00", allocation_amount: "0.00" },
      COMPANY: { allocation_rate: "0.00", allocation_amount: "0.00" },
    });
    expect(replaced.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [3], allocation_rate: "100.00", allocation_amount: "30.00" }),
    ]);

    // 台账没登记该动作执行人时（候选为空）不联动，存量原样回显。
    const noCandidate = buildActionAllocationRows([
      { allocation_type: "BUY", user_id: 1, role: "BUYER", allocation_rate: "100", allocation_amount: "30" },
    ], { BUY: [], SELL: [], OPERATION: [], COMPANY: [] }, {
      BUY: { allocation_rate: "100.00", allocation_amount: "30.00" },
    });
    expect(noCandidate.filter((row) => row.allocation_type === "BUY")).toEqual([
      expect.objectContaining({ employee_ids: [1], allocation_amount: "30.00" }),
    ]);
  });
});
