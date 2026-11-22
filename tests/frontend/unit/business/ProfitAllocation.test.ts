import { describe, expect, it } from "vitest";
import { buildAllocationOptionGroups } from "@/business/profit_allocation/allocationHelpers";

describe("分润配置纯逻辑", () => {
  it("分润候选按动作预分组并保留员工原顺序和禁用状态", () => {
    let reads = 0;
    const options = Array.from({ length: 200 }, (_, index) => ({
      get value() { reads += 1; return index + 1; }, label: `员工${index + 1}`, disabled: index === 1,
    }));
    const company = { value: "COMPANY" as const, label: "公司", disabled: false };
    const groups = buildAllocationOptionGroups({ BUY: [1, 2], SELL: [2, 3], OPERATION: [], COMPANY: [] }, [...options, company]);
    expect(groups.BUY.map((item) => item.label)).toEqual(["员工1", "员工2"]);
    expect(groups.BUY[1].disabled).toBe(true);
    expect(groups.SELL.map((item) => item.label)).toEqual(["员工2", "员工3"]);
    expect(groups.other).toHaveLength(200);
    expect(reads).toBeLessThanOrEqual(400);
  });
});
