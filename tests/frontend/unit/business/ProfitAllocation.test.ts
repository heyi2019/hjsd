import { describe, expect, it } from "vitest";
import { buildAllocationOptionGroups, convertAllocationValue } from "@/business/profit_allocation/allocationHelpers";

describe("分润配置纯逻辑", () => {
  it.each([
    ["500.00", "RATE_TO_AMOUNT", "20", "100.00"],
    ["0.05", "RATE_TO_AMOUNT", "10", "0.01"],
    ["-0.05", "RATE_TO_AMOUNT", "10", "-0.01"],
    ["1234567890123456.78", "RATE_TO_AMOUNT", "10", "123456789012345.68"],
    ["500.00", "AMOUNT_TO_RATE", "100", "20.00"],
    ["-500.00", "AMOUNT_TO_RATE", "-125", "25.00"],
    ["0.00", "RATE_TO_AMOUNT", "25", "0.00"],
    ["0.00", "AMOUNT_TO_RATE", "1", null],
    ["500.00", "RATE_TO_AMOUNT", "101", null],
    ["500.00", "RATE_TO_AMOUNT", "abc", null],
  ] as const)("利润 %s 按 %s %s 即时换算", (profit, direction, value, expected) => {
    expect(convertAllocationValue(profit, direction, value)).toBe(expected);
  });
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
