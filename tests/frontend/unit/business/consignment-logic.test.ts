import { describe, expect, it } from "vitest";
import type { AccountExecutionEvent, AccountExecutionOrder } from "@/shared/api/types/account-execution";
import { consignmentListings, consignmentPlatform, isActiveConsignmentListing, isConsignmentListing } from "@/business/operations/consignment-logic";

const event = (overrides: Partial<AccountExecutionEvent>): AccountExecutionEvent => ({
  id: 1,
  event_no: "EV-1",
  event_type: "OPERATE",
  amount: "0.00",
  cancellable_amount: "0.00",
  occurred_on: "2026-11-02",
  portion: "NONE",
  is_posted: true,
  operator: "pytest",
  ...overrides,
});

const order = (overrides: Partial<AccountExecutionOrder> = {}) => ({
  order_id: 1,
  order_no: "DG-1",
  order_type: "DG",
  status: "ACTIVE",
  events: [],
  ...overrides,
} as unknown as AccountExecutionOrder);

describe("代挂寄售记录口径", () => {
  it("没有寄售运营事件时不是寄售上架记录", () => {
    const initial = order();
    expect(consignmentPlatform(initial)).toBeNull();
    expect(isConsignmentListing(initial)).toBe(false);
    expect(isActiveConsignmentListing(initial)).toBe(false);
  });

  it("原订单的寄售运营事件才是当前寄售上架记录", () => {
    const listed = order({
      order_type: "HS",
      events: [{
        ...event({ id: 7, operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"], listed_at: "2026-11-02T10:05" } }),
      }],
    });
    expect(consignmentPlatform(listed)).toBe("盼之");
    expect(isConsignmentListing(listed)).toBe(true);
    expect(isActiveConsignmentListing(listed)).toBe(true);
  });

  it("平台下架后不再进入当前上架列表", () => {
    const unlisted = order({
      order_type: "HS",
      events: [{
        ...event({ id: 7, operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["盼之"], listed_at: "2026-11-02T10:05" } }),
      }, {
        ...event({ id: 8, operation_type: "UNLIST", form_extra: { consignment_event_id: 7, consignment_platforms: ["盼之"], platform_unlist_scope: "PLATFORM" } }),
      }],
    });
    expect(isConsignmentListing(unlisted)).toBe(true);
    expect(isActiveConsignmentListing(unlisted)).toBe(false);
  });

  it("单平台上架改名后仍按关联事件识别已下架", () => {
    const edited = order({ events: [
      event({ id: 7, operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["新平台"] } }),
      event({ id: 8, operation_type: "UNLIST", form_extra: { consignment_event_id: 7, consignment_platforms: ["旧平台"], platform_unlist_scope: "PLATFORM" } }),
    ] });
    expect(consignmentListings([edited])).toEqual([]);
  });

  it("多平台上架仅移除对应平台", () => {
    const listed = order({ events: [
      event({ id: 7, operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["平台甲", "平台乙"] } }),
      event({ id: 8, operation_type: "UNLIST", form_extra: { consignment_event_id: 7, consignment_platforms: ["平台甲"], platform_unlist_scope: "PLATFORM" } }),
    ] });
    expect(consignmentListings([listed]).map((item) => item.platform)).toEqual(["平台乙"]);
  });

  it("同一订单的多条寄售记录拥有各自稳定标识", () => {
    const listed = order({
      events: [
        event({ id: 7, operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["千寻"], listed_at: "2026-11-02T10:05" } }),
        event({ id: 8, operation_type: "CONSIGNMENT", form_extra: { consignment_platforms: ["千寻"], listed_at: "2026-11-02T10:10" } }),
      ],
    });

    expect(consignmentListings([listed]).map((item) => item.id)).toEqual([
      "1:7:千寻",
      "1:8:千寻",
    ]);
  });
});
