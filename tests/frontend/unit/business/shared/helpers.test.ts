import { describe, expect, it } from "vitest";
import type { Order } from "@/shared/api/types/orders";
import { formatOrderAmount } from "@/business/orders/helpers";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: 1,
  order_no: "HS-2026-0001",
  order_type: "HS",
  trade_date: "2026-10-01",
  status: "ACTIVE",
  business_mode: "SELF",
  ...overrides,
});

describe("OrdersPage helpers", () => {
  it("格式化订单售出金额，不把买入金额混进来", () => {
    expect(formatOrderAmount(order({ sale_amount: "1500.00" }))).toBe("¥1,500.00");
    expect(formatOrderAmount(order({ sale_amount: null }))).toBe("-");
  });

});
