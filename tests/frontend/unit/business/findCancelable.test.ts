import { describe, expect, it } from "vitest";
import { findCancelableBuy } from "@/business/inventory/InventoryPanel/helpers";
import type { AccountExecutionDetail } from "@/shared/api/types/account-execution";

const detail = (orders: unknown[]) => ({ orders }) as unknown as AccountExecutionDetail;

describe("查找可冲销买入", () => {
  it("倒序取最近的买入事件，忽略售出事件", () => {
    const d = detail([{ order_id: "O1", events: [
      { id: 1, event_type: "BUY", cancellable_amount: "100.00", portion: 1 },
      { id: 2, event_type: "BUY", cancellable_amount: "200.00", portion: 1 },
      { id: 3, event_type: "SELL", cancellable_amount: "300.00", portion: 1 },
    ] }]);
    expect(findCancelableBuy(d)).toEqual({ orderId: "O1", eventId: 2, amount: "200.00", portion: 1 });
  });

  it("跳过已无可冲销余额的事件", () => {
    const d = detail([{ order_id: "O1", events: [
      { id: 1, event_type: "BUY", cancellable_amount: "100.00", portion: 1 },
      { id: 2, event_type: "BUY", cancellable_amount: "0.00", portion: 1 },
    ] }]);
    expect(findCancelableBuy(d)).toEqual({ orderId: "O1", eventId: 1, amount: "100.00", portion: 1 });
  });

  it("直接使用后端下发的可冲销余额", () => {
    const d = detail([{ order_id: "O1", events: [
      { id: 1, event_type: "BUY", amount: "100.00", cancellable_amount: "70.00", portion: 1 },
      { id: 2, event_type: "CANCEL", offset_event_id: 1, amount: "59.00", cancellable_amount: "0.00" },
    ] }]);
    expect(findCancelableBuy(d)?.amount).toBe("70.00");
  });

  it("跨订单时取最近订单的可冲销买入", () => {
    const d = detail([
      { order_id: "O1", events: [{ id: 1, event_type: "BUY", cancellable_amount: "10.00", portion: 1 }] },
      { order_id: "O2", events: [{ id: 2, event_type: "BUY", cancellable_amount: "20.00", portion: 1 }] },
    ]);
    expect(findCancelableBuy(d)).toEqual({ orderId: "O2", eventId: 2, amount: "20.00", portion: 1 });
  });

  it("没有可冲销买入时返回 null", () => {
    const d = detail([{ order_id: "O1", events: [
      { id: 1, event_type: "BUY", cancellable_amount: "0.00", portion: 1 },
      { id: 2, event_type: "SELL", cancellable_amount: "100.00", portion: 1 },
    ] }]);
    expect(findCancelableBuy(d)).toBeNull();
  });
});
