import { describe, expect, it } from "vitest";
import type { AccountExecutionOrder } from "@/shared/api/types/account-execution";
import { availableConsignmentPlatforms, consignmentListings, isActiveConsignmentListing } from "@/business/shared/operations/consignment-logic";

const order = (overrides: Partial<AccountExecutionOrder> = {}): AccountExecutionOrder => ({
  order_id: 1, order_no: "DG0001", order_type: "DG", trade_date: "2026-11-02",
  status: "ACTIVE", events: [], operator: "pytest", ...overrides,
});

describe("寄售上架状态", () => {
  it("当前记录以后端返回为准，不从历史事件重新推算", () => {
    const source = order({
      events: [{ id: 7, event_no: "EV7", event_type: "OPERATE", operation_type: "CONSIGNMENT",
        amount: "0", cancellable_amount: "0", occurred_on: "2026-11-02", portion: "NONE", is_posted: true,
        operator: "pytest", form_extra: { consignment_platforms: ["历史平台"] } }],
      active_consignments: [{ event_id: 8, platform: "当前平台", price: "120.00", listed_at: "2026-11-02T10:05:00" }],
    });
    expect(consignmentListings([source])).toEqual([{ id: "1:8:当前平台", orderId: 1, orderNo: "DG0001",
      eventId: 8, platform: "当前平台", price: "120.00", listedAt: "2026-11-02 10:05" }]);
    expect(isActiveConsignmentListing(source)).toBe(true);
  });

  it("未收到上架状态时不凭事件猜测，多个事件保留各自标识", () => {
    expect(isActiveConsignmentListing(order())).toBe(false);
    const source = order({ active_consignments: [
      { event_id: 7, platform: "千寻", price: null, listed_at: "2026-11-02T10:05:00" },
      { event_id: 8, platform: "千寻", price: null, listed_at: "2026-11-02T10:10:00" },
    ] });
    expect(consignmentListings([source]).map((item) => item.id)).toEqual(["1:7:千寻", "1:8:千寻"]);
  });

  it("平台候选排除已上架平台并保留原选项顺序", () => {
    const listed = Array.from({ length: 100 }, (_, index) => ({ platform: `平台${index}` }));
    const options = Array.from({ length: 200 }, (_, index) => ({ value: `平台${index}`, label: `名称${index}` }));
    expect(availableConsignmentPlatforms(options, listed)).toEqual(options.slice(100));
  });
});
