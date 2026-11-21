import { describe, expect, it } from "vitest";
import { buildAllocationOptionGroups, pickCancelableEvent, resolveCancelAmount, resolveCancellationOperators } from "@/business/orders/helpers";
import { indexEmployeeNames } from "@/business/shared/employee-names";

describe("订单台账冲销 helpers", () => {
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
  it("按员工编号建立姓名索引，重复编号保留首名并线性读取", () => {
    let reads = 0;
    const employees = Array.from({ length: 200 }, (_, index) => ({
      get id() { reads += 1; return index + 1; }, display_name: `员工${index + 1}`,
    }));
    const result = indexEmployeeNames([...employees, { id: 1, display_name: "后来的同编号" }]);
    expect(result.get(1)).toBe("员工1");
    expect(result.get(200)).toBe("员工200");
    expect(result.get(201)).toBeUndefined();
    expect(reads).toBeLessThanOrEqual(400);
  });
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

  it("大额冲销超过剩余一分时拒绝", () => {
    expect(resolveCancelAmount({ scope: "ORDERCANC", values: { cancel_amount: "9999999999999999.99" }, remaining: "9999999999999999.98" }))
      .toEqual({ ok: false, error: "冲销金额不能超过该动作剩余可冲金额 ¥9999999999999999.98" });
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
