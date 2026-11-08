import { describe, expect, it } from "vitest";
import { accountFinancialFlows, INVENTORY_AGE_COLOR, rebateTypeLabel, INVENTORY_TYPE_LABEL } from "@/stocks/inventory-logic";

describe("库存纯逻辑", () => {
  it("展示提号库存类型", () => {
    expect(INVENTORY_TYPE_LABEL.PICKUP).toBe("提号");
  });

  // 库龄天数与 7/30 天档位由后端下发（见 tests/backend/unit/business/test_account_inventory_age.py），
  // 前端只剩「档位 → 颜色」这一层展示映射。
  it("库龄档位映射到标签颜色", () => {
    expect(INVENTORY_AGE_COLOR.NORMAL).toBe("green");
    expect(INVENTORY_AGE_COLOR.WARNING).toBe("orange");
    expect(INVENTORY_AGE_COLOR.OVERDUE).toBe("red");
    expect(Object.keys(INVENTORY_AGE_COLOR)).toHaveLength(3);
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
