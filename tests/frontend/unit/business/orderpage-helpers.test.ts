import { describe, expect, it } from "vitest";
import { pickCancelableEvent, resolveCancelAmount, resolveCancellationOperators } from "@/business/orderpage/helpers";

describe("订单台账冲销 helpers", () => {
  it("冲销操作人优先使用表单选择，其次匹配当前员工，最后匹配登录会话", async () => {
    const employees = [{ id: 1, username: "alice" }, { id: 2, username: "bob" }];
    const session = async () => ({ id: 2, username: "bob" });
    expect(await resolveCancellationOperators([7], employees, "alice", session)).toEqual([7]);
    expect(await resolveCancellationOperators([], employees, "alice", session)).toEqual([1]);
    expect(await resolveCancellationOperators([], employees, "unknown", session)).toEqual([2]);
    expect(await resolveCancellationOperators([], [employees[0]], "unknown", session)).toEqual([1]);
    expect(await resolveCancellationOperators([], employees, "unknown", async () => { throw new Error("offline"); })).toBeUndefined();
  });
  const remaining = "500.00";

  it("留空时按后端剩余金额全额冲销", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: {}, remaining })).toEqual({ ok: true, amount: "500.00" });
    expect(resolveCancelAmount({ scope: "INVREFUND", values: { refund_amount: "" }, remaining })).toEqual({ ok: true, amount: "500.00" });
  });

  it("部分冲销按填写金额提交", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "300" }, remaining }))
      .toEqual({ ok: true, amount: "300" });
  });

  it("超过剩余金额时拒绝并提示剩余金额", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "500.01" }, remaining }))
      .toEqual({ ok: false, error: "冲销金额不能超过该动作剩余可冲金额 ¥500.00" });
  });

  it("恰好等于剩余金额时放行", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "500.00" }, remaining }))
      .toEqual({ ok: true, amount: "500.00" });
  });

  it("非数字、零和负数拒绝为空间无效金额", () => {
    for (const bad of ["abc", "0", "-1", " "]) {
      const result = resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: bad }, remaining });
      if (bad === " ") expect(result).toEqual({ ok: true, amount: "500.00" });
      else expect(result).toEqual({ ok: false, error: "请输入有效的冲销金额" });
    }
  });

  it("不同 scope 读取各自的金额字段", () => {
    expect(resolveCancelAmount({ scope: "INVREFUND", values: { refund_amount: "120", cancel_amount: "999" }, remaining }))
      .toEqual({ ok: true, amount: "120" });
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { refund_amount: "999", cancel_amount: "120" }, remaining }))
      .toEqual({ ok: true, amount: "120" });
  });

  it("pickCancelableEvent 优先显式选择，否则取第一条", () => {
    const list = [
      { event: { id: 102 }, remaining: "500.00" },
      { event: { id: 101 }, remaining: "1000.00" },
    ];
    expect(pickCancelableEvent(list, 101)?.event.id).toBe(101);
    expect(pickCancelableEvent(list, undefined)?.event.id).toBe(102);
    expect(pickCancelableEvent(list, "101")?.event.id).toBe(101);
    expect(pickCancelableEvent(list, 999)?.event.id).toBe(102);
    expect(pickCancelableEvent([], 101)).toBeUndefined();
  });
});
