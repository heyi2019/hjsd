import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_STATUS_LABEL,
  EVENT_TYPE_LABEL,
  executionActionLabel,
  formatDateTimeMinute,
  formatElapsedTime,
  INSTALLMENT_STATUS_LABEL,
  ORDER_STATUS_LABEL,
  money,
  signedMoney,
  statusColor,
  today,
} from "@/shared/lib/format";

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


describe("formatDateTimeMinute：时间展示统一到分钟", () => {
  it("保留日期和时分，隐藏秒与小数", () => {
    expect(formatDateTimeMinute("2026-11-01T12:34:56.789")).toBe("2026-11-01 12:34");
  });

  it("空时间显示横线", () => {
    expect(formatDateTimeMinute(null)).toBe("-");
  });
});

describe("formatElapsedTime：在手时间", () => {
  it("按售出时间减入库时间展示天小时分钟", () => {
    expect(formatElapsedTime("2026-10-01T09:30:00", "2026-10-17T16:45:00")).toBe("16天7小时15分");
  });

  it("缺少售出时间时显示横线", () => {
    expect(formatElapsedTime("2026-10-01T09:30:00", null)).toBe("-");
  });
});

describe("状态枚举标签：与后端枚举一一对应", () => {
  it("订单状态覆盖后端 OrderStatus", () => {
    expect(Object.keys(ORDER_STATUS_LABEL).sort()).toEqual(
      ["ACTIVE", "CANCELLED", "COMPLETED", "INSTALLMENT"].sort(),
    );
  });

  it("分期状态只展示对外业务状态", () => {
    expect(Object.keys(INSTALLMENT_STATUS_LABEL).sort()).toEqual(
      ["ACTIVE", "CANCELLED", "CLOSED", "DEFAULTED", "DELIVERED", "OVERDUE", "SETTLED"].sort(),
    );
    expect(INSTALLMENT_STATUS_LABEL.ACTIVE).toBe("还款中");
    expect(INSTALLMENT_STATUS_LABEL.PENDING).toBeUndefined();
  });

  it("账号状态覆盖后端 AccountStatus", () => {
    expect(Object.keys(ACCOUNT_STATUS_LABEL).sort()).toEqual(
      ["WAITING", "SOLD", "VOID"].sort(),
    );
    expect(ACCOUNT_STATUS_LABEL.WAITING).toBe("在库");
  });

  it("事件类型覆盖后端 EventType", () => {
    expect(Object.keys(EVENT_TYPE_LABEL).sort()).toEqual(
      ["BUY", "CANCEL", "DELIVER", "OPERATE", "REBATE", "SELL"].sort(),
    );
  });

  it("交付动作文案：按交付方向区分买号交付与卖号交付", () => {
    expect(executionActionLabel("DELIVER", "HS")).toBe("卖号交付");
    expect(executionActionLabel("DELIVER", "DG", "BUY")).toBe("买号交付");
    expect(executionActionLabel("BUY", "HS")).toBe("买号");
    expect(executionActionLabel("OPERATE", "DG")).toBe("运营");
    expect(executionActionLabel("REBATE", "HS")).toBe("返点");
  });
});

describe("statusColor：颜色只做辅助", () => {
  it("正向/完成态为绿", () => {
    for (const s of ["ACTIVE", "PAID", "SETTLED", "IN_STOCK"]) {
      expect(statusColor(s)).toBe("green");
    }
  });

  it("库存状态用高对比颜色区分在库与出库", () => {
    expect(statusColor("WAITING")).toBe("green");
    expect(statusColor("SOLD")).toBe("red");
    expect(statusColor("VOID")).toBe("red");
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
