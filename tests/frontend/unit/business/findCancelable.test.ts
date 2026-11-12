import { describe, expect, it } from "vitest";
import { findCancelableBuy, findCancelableEvent, findCancelableSale } from "@/stocks/InventoryPanel";
import type { AccountExecutionDetail } from "@/shared/api/types/account-execution";

/**
 * 用最小结构拼装 execution detail，只覆盖被测函数实际读取的字段。
 *
 * 「还能冲多少」由后端算好放在 `cancellable_amount`（口径与冲销校验同源），
 * 本文件只守一件事：从后往前挑哪一条 —— 金额是否等于后端下发值、是否还会
 * 因为 CANCEL 事件在本地被相减（那是后端 test_execution_cancellable_amount 的事）。
 */
const detail = (orders: unknown[]) => ({ orders }) as unknown as AccountExecutionDetail;

describe("findCancelableEvent", () => {
  it("倒序取最近一条可冲销的 SELL 事件", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", cancellable_amount: "100.00", portion: 1 },
          { id: 2, event_type: "SELL", amount: "200.00", cancellable_amount: "200.00", portion: 1 },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toEqual({ orderId: "O1", eventId: 2, amount: "200.00", portion: 1 });
  });

  it("已无可冲销余额的事件要跳过，回退到更早的一条", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", cancellable_amount: "100.00", portion: 1 },
          { id: 2, event_type: "SELL", amount: "200.00", cancellable_amount: "0.00", portion: 1 },
          { id: 3, event_type: "CANCEL", offset_event_id: 2, amount: "200.00", cancellable_amount: "0.00" },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toEqual({ orderId: "O1", eventId: 1, amount: "100.00", portion: 1 });
  });

  it("直接采用后端下发的可冲销余额，不再本地相减", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          // amount 仍是原始 100，可冲销只剩 70：返回的必须是 70，而不是自己算的 100。
          { id: 1, event_type: "SELL", amount: "100.00", cancellable_amount: "70.00", portion: 1 },
          { id: 2, event_type: "CANCEL", offset_event_id: 1, amount: "30.00", cancellable_amount: "0.00" },
          // 故意让「金额 − 冲销合计」与后端值不等：若前端仍在算，这里会得到 41.00。
          { id: 3, event_type: "CANCEL", offset_event_id: 1, amount: "29.00", cancellable_amount: "0.00" },
        ],
      },
    ]);
    expect(findCancelableSale(d)?.amount).toBe("70.00");
  });

  it("BUY 与 SELL 互不干扰，各自只认自己的事件类型", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "BUY", amount: "50.00", cancellable_amount: "50.00", portion: 1 },
          { id: 2, event_type: "SELL", amount: "80.00", cancellable_amount: "80.00", portion: 1 },
        ],
      },
    ]);
    expect(findCancelableBuy(d)?.eventId).toBe(1);
    expect(findCancelableSale(d)?.eventId).toBe(2);
  });

  it("跨订单时取最近的订单", () => {
    const d = detail([
      { order_id: "O1", events: [{ id: 1, event_type: "BUY", amount: "10.00", cancellable_amount: "10.00", portion: 1 }] },
      { order_id: "O2", events: [{ id: 2, event_type: "BUY", amount: "20.00", cancellable_amount: "20.00", portion: 1 }] },
    ]);
    expect(findCancelableBuy(d)).toEqual({ orderId: "O2", eventId: 2, amount: "20.00", portion: 1 });
  });

  it("全部无可冲销余额时返回 null", () => {
    const d = detail([
      {
        order_id: "O1",
        events: [
          { id: 1, event_type: "SELL", amount: "100.00", cancellable_amount: "0.00", portion: 1 },
          { id: 2, event_type: "CANCEL", offset_event_id: 1, amount: "100.00", cancellable_amount: "0.00" },
        ],
      },
    ]);
    expect(findCancelableSale(d)).toBeNull();
  });

  it("参数化入口与语义化别名一致", () => {
    const d = detail([
      { order_id: "O1", events: [{ id: 1, event_type: "BUY", amount: "10.00", cancellable_amount: "10.00", portion: 1 }] },
    ]);
    expect(findCancelableEvent(d, "BUY")).toEqual(findCancelableBuy(d));
    expect(findCancelableEvent(d, "SELL")).toBeNull();
  });
});
