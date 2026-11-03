import { describe, expect, it } from "vitest";
import type { AccountExecutionOrder } from "@/shared/api/catalog";
import { consignmentPlatform, isActiveConsignmentListing, isConsignmentListing } from "@/stocks/consignment-logic";

const order = (overrides: Partial<AccountExecutionOrder> = {}) => ({
  order_id: 1,
  order_no: "DG-1",
  order_type: "DG",
  status: "ACTIVE",
  events: [],
  ...overrides,
} as unknown as AccountExecutionOrder);

describe("代挂寄售记录口径", () => {
  it("初始 DG 建单没有平台时不是寄售上架记录", () => {
    const initial = order();
    expect(consignmentPlatform(initial)).toBeNull();
    expect(isConsignmentListing(initial)).toBe(false);
    expect(isActiveConsignmentListing(initial)).toBe(false);
  });

  it("有明确平台的 DG 才是当前寄售上架记录", () => {
    const listed = order({ extra_values: { consignment_platform: "盼之", listed_at: "2026-11-02T10:05" } });
    expect(consignmentPlatform(listed)).toBe("盼之");
    expect(isConsignmentListing(listed)).toBe(true);
    expect(isActiveConsignmentListing(listed)).toBe(true);
  });

  it("平台下架后不再进入当前上架列表", () => {
    const unlisted = order({
      extra_values: { consignment_platform: "盼之", platform_unlist_scope: "PLATFORM" },
    });
    expect(isConsignmentListing(unlisted)).toBe(true);
    expect(isActiveConsignmentListing(unlisted)).toBe(false);
  });
});
