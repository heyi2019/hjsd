import { describe, expect, it } from "vitest";
import { findCancelableBuy, findCancelableEvent, findCancelableSale } from "./InventoryPanel";
import type { AccountExecutionDetail } from "../shared/api/catalog";

/** 用最小结构拼装 execution detail，只覆盖被测函数实际读取的字段。 */
const detail = (orders: unknown[]) => ({ orders }) as unknown as AccountExecutionDetail;

describe("findCancelableEvent", () => {
  it("倒序取最近一条未冲销的 SELL 事件", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", portion: 1 },
          { id: 2, event_type: "SELL", amount: "200.00", portion: 1 },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toEqual({ orderId: "O1", eventId: 2, amount: "200.00", portion: 1 });
  });

  it("已全额冲销的事件要跳过，回退到更早的一条", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", portion: 1 },
          { id: 2, event_type: "SELL", amount: "200.00", portion: 1 },
          { id: 3, event_type: "CANCEL", offset_event_id: 2, amount: "200.00" },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toEqual({ orderId: "O1", eventId: 1, amount: "100.00", portion: 1 });
  });

  it("按部分冲销后的余额计算", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", portion: 1 },
          { id: 2, event_type: "CANCEL", offset_event_id: 1, amount: "30.00" },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toEqual({ orderId: "O1", eventId: 1, amount: "70.00", portion: 1 });
  });

  it("BUY 与 SELL 互不干扰，各自只认自己的事件类型", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "BUY", amount: "50.00", portion: 1 },
          { id: 2, event_type: "SELL", amount: "80.00", portion: 1 },
        ],
      },
    ]);
    expect(findCancelableBuy(d)?.eventId).toBe(1);
    expect(findCancelableSale(d)?.eventId).toBe(2);
  });

  it("跨订单时取最近的订单", () => {
    const d = detail([
      { order_id: "O1", events: [{ id: 1, event_type: "BUY", amount: "10.00", portion: 1 }] },
      { order_id: "O2", events: [{ id: 2, event_type: "BUY", amount: "20.00", portion: 1 }] },
    ]);
    expect(findCancelableBuy(d)).toEqual({ orderId: "O2", eventId: 2, amount: "20.00", portion: 1 });
  });

  it("没有可冲销事件时返回 null", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", portion: 1 },
          { id: 2, event_type: "CANCEL", offset_event_id: 1, amount: "100.00" },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toBeNull();
  });

  it("参数化入口与语义化别名一致", () => {
    const d = detail([
      { order_id: "O1", events: [{ id: 1, event_type: "BUY", amount: "10.00", portion: 1 }] },
    ]);
    expect(findCancelableEvent(d, "BUY")).toEqual(findCancelableBuy(d));
    expect(findCancelableEvent(d, "SELL")).toBeNull();
  });
});
