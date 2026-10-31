import { describe, expect, it } from "vitest";
import { accountFinancialFlows, inventoryAge, rebateTypeLabel, INVENTORY_TYPE_LABEL } from "./inventory-logic";

describe("库存纯逻辑", () => {
  it("展示提号库存类型", () => {
    expect(INVENTORY_TYPE_LABEL.PICKUP).toBe("提号");
  });

  it("按在库天数返回绿色、橙色、红色等级", () => {
    const now = new Date("2026-10-17T12:00:00");
    expect(inventoryAge({ status: "IN_STOCK", buy_date: "2026-10-15" }, now)).toEqual({ days: 2, color: "green" });
    expect(inventoryAge({ status: "IN_STOCK", buy_date: "2026-09-20" }, now)).toEqual({ days: 27, color: "orange" });
    expect(inventoryAge({ status: "IN_STOCK", buy_date: "2026-09-01" }, now)).toEqual({ days: 46, color: "red" });
  });

  it("非在库状态不计算未售时长", () => {
    expect(inventoryAge({ status: "SOLD", buy_date: "2026-10-01" }, new Date("2026-10-17T12:00:00"))).toBeNull();
    expect(inventoryAge({ status: "SOLD", inventory_status: "OUT_OF_STOCK", buy_date: "2026-10-01" }, new Date("2026-10-17T12:00:00"))).toBeNull();
  });

  it("返点类型优先使用业务类型", () => {
    expect(rebateTypeLabel("BUY", "卖号返点")).toBe("买号返点");
    expect(rebateTypeLabel(null, "卖号返点")).toBe("卖号返点");
  });

  it("资金明细同时归集动作流水和订单附加流水", () => {
    const detail = {
      orders: [{
        order_no: "HS0001",
        events: [{ event_no: "EV1", cashflow: { flow_no: "CF1" } }],
        cashflows: [{ flow_no: "CF2" }],
      }],
    } as never;
    expect(accountFinancialFlows(detail)).toHaveLength(2);
  });
});
