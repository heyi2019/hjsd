import { describe, expect, it } from "vitest";
import type { Order } from "../shared/api/catalog";
import {
  filterBusinessOrders,
  formatOrderAmount,
  validateAllocations,
} from "./OrdersPage.helpers";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  capital_type: "SELF",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  event_total: "1234.00",
  ...overrides,
});

describe("OrdersPage helpers", () => {
  it("按业务类型、模式、游戏和库存状态筛选订单", () => {
    expect(filterBusinessOrders([
      order({ account_game_type: "原神", account_status: "WAITING" }),
      order({ id: 2, order_no: "DG-2026-0002", order_type: "DG", business_mode: "DISTRIBUTION" }),
    ], "HS", "SELF", "原神", "原神", "WAITING")).toHaveLength(1);
  });

  it("格式化订单金额并保留分期口径", () => {
    expect(formatOrderAmount(order())).toBe("¥1,234.00");
    expect(formatOrderAmount(order({ installment_principal: "12000.00", installment_paid: "3000.00", installment_periods: 6 }))).toContain("¥3000.00/12000.00");
  });

  it("校验比例分润并归一化公司归属", () => {
    expect(validateAllocations([{ employee: "COMPANY", allocation_rate: "100" }], "5000.00")).toEqual({
      ok: true,
      items: [{ user_id: null, role: "OWNER", allocation_rate: "100", allocation_amount: "0" }],
    });
  });
});
