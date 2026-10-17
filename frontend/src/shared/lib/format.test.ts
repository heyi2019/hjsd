import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_STATUS_LABEL,
  EVENT_TYPE_LABEL,
  executionActionLabel,
  INSTALLMENT_STATUS_LABEL,
  ORDER_STATUS_LABEL,
  money,
  signedMoney,
  statusColor,
  today,
} from "./format";

afterEach(() => {
  vi.useRealTimers();
});

describe("money：金额展示（前端不做浮点运算，只格式化）", () => {
  it("千分位 + 固定两位小数", () => {
    expect(money("1234.5")).toBe("1,234.50");
    expect(money("1000")).toBe("1,000.00");
  });

  it("后端 DECIMAL 以字符串传入，不走浮点：0.1+0.2 类误差不出现", () => {
    // 若实现改成 Number(a)+Number(b)，这里会暴露精度问题
    expect(money("0.1")).toBe("0.10");
    expect(money("0.2")).toBe("0.20");
  });

  it("空值统一显示 -（null/undefined/空串）", () => {
    expect(money(null)).toBe("-");
    expect(money(undefined)).toBe("-");
    expect(money("")).toBe("-");
  });

  it("非数字字符串原样返回，不显示 NaN", () => {
    expect(money("abc")).toBe("abc");
    expect(money("N/A")).toBe("N/A");
  });

  it("负数保留负号", () => {
    expect(money("-88.9")).toBe("-88.90");
  });

  it("number 入参同样按两位小数展示", () => {
    expect(money(1234.567)).toBe("1,234.57");
  });

  it("signedMoney 与 money 同口径（当前不额外加正号）", () => {
    expect(signedMoney("12.3")).toBe(money("12.3"));
  });
});

describe("today：本地日期字符串", () => {
  it("YYYY-MM-DD 且月日补零", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0)); // 本地时间 2026-01-05
    expect(today()).toBe("2026-01-05");
  });
});

describe("状态枚举标签：与后端枚举一一对应", () => {
  it("订单状态覆盖后端 OrderStatus", () => {
    expect(Object.keys(ORDER_STATUS_LABEL).sort()).toEqual(
      ["ACTIVE", "CANCELLED", "COMPLETED"].sort(),
    );
  });

  it("分期状态覆盖后端 InstallmentStatus", () => {
    expect(Object.keys(INSTALLMENT_STATUS_LABEL).sort()).toEqual(
      ["ACTIVE", "CANCELLED", "DEFAULTED", "DELIVERED", "OVERDUE", "PENDING", "SETTLED"].sort(),
    );
  });

  it("账号状态覆盖后端 AccountStatus", () => {
    expect(Object.keys(ACCOUNT_STATUS_LABEL).sort()).toEqual(
      ["IN_STOCK", "INSTALLMENT", "SOLD", "VOID"].sort(),
    );
  });

  it("事件类型覆盖后端 EventType", () => {
    expect(Object.keys(EVENT_TYPE_LABEL).sort()).toEqual(
      ["BUY", "CANCEL", "COST", "DELIVER", "PAYMENT", "SELL"].sort(),
    );
  });

  it("交付动作按订单类型区分买入交付与卖号交付", () => {
    expect(executionActionLabel("DELIVER", "DFQ")).toBe("卖号交付");
    expect(executionActionLabel("DELIVER", "HS")).toBe("买入交付");
    expect(executionActionLabel("PAYMENT", "DFQ")).toBe("回款（分期）");
  });
});

describe("statusColor：颜色只做辅助", () => {
  it("正向/完成态为绿", () => {
    for (const s of ["ACTIVE", "PAID", "SETTLED", "IN_STOCK"]) {
      expect(statusColor(s)).toBe("green");
    }
  });

  it("进行中/待结算为蓝", () => {
    for (const s of ["DRAFT", "PENDING", "PARTIALLY_RETURNED", "PARTIALLY_SETTLED", "INSTALLMENT"]) {
      expect(statusColor(s)).toBe("blue");
    }
  });

  it("风险态为红", () => {
    for (const s of ["OVERDUE", "DEFAULTED", "DISABLED"]) {
      expect(statusColor(s)).toBe("red");
    }
  });

  it("终态为青", () => {
    for (const s of ["COMPLETED", "DELIVERED", "RETURNED"]) {
      expect(statusColor(s)).toBe("cyan");
    }
  });

  it("未知状态回落 default，不抛错", () => {
    expect(statusColor("SOMETHING_NEW")).toBe("default");
  });
});
