import { describe, expect, it } from "vitest";
import {
  formatCents,
  lastPeriodAmount,
  perPeriodServiceFee,
  saleInstallmentMismatch,
  saleInstallmentPlan,
  toCents,
} from "./sale-plan";

describe("sale-plan：售卖分期金额规划（整数分运算）", () => {
  it("整除时每期与末期相等", () => {
    const plan = saleInstallmentPlan({ saleAmount: "1000", downPayment: "0", serviceFee: "0", periods: 4 })!;
    expect(plan.perPeriod).toBe("250.00");
    expect(plan.lastPeriod).toBe("250.00");
  });

  it("除不尽时每期向上取整到分，尾差由末期吸收", () => {
    const plan = saleInstallmentPlan({ saleAmount: "1000", downPayment: "0", serviceFee: "0", periods: 3 })!;
    expect(plan.perPeriod).toBe("333.34");
    expect(plan.lastPeriod).toBe("333.32");
    // 三期的分相加必须精确等于总额，不留浮点残渣。
    expect(plan.perPeriodCents * 2 + plan.lastPeriodCents).toBe(plan.totalCents);
  });

  it("首付和服务费一起计入总额", () => {
    const plan = saleInstallmentPlan({ saleAmount: "1200", downPayment: "200", serviceFee: "100", periods: 3 })!;
    expect(plan.baseCents).toBe(100000);
    expect(plan.totalCents).toBe(110000);
    expect(plan.perPeriod).toBe("366.67");
    expect(plan.lastPeriod).toBe("366.66");
  });

  it("0.1 + 0.2 这类小数不会出现浮点尾差", () => {
    const plan = saleInstallmentPlan({ saleAmount: "0.3", downPayment: "0.1", serviceFee: 0, periods: 2 })!;
    expect(plan.totalCents).toBe(20);
    expect(plan.perPeriod).toBe("0.10");
    expect(plan.lastPeriod).toBe("0.10");
  });

  it("期数非正整数或金额非数字时返回 null（交给各自字段报错）", () => {
    expect(saleInstallmentPlan({ saleAmount: "1000", periods: 0 })).toBeNull();
    expect(saleInstallmentPlan({ saleAmount: "1000", periods: 2.5 })).toBeNull();
    expect(saleInstallmentPlan({ saleAmount: "abc", periods: 3 })).toBeNull();
  });

  it("末期金额按用户填写的每期金额反推", () => {
    const plan = saleInstallmentPlan({ saleAmount: "1000", downPayment: "0", serviceFee: "0", periods: 3 })!;
    expect(lastPeriodAmount(plan, "300")).toBe("400.00");
    expect(lastPeriodAmount(plan, "abc")).toBeNull();
  });

  it("每期金额校验：收不回本金、末期算成负数、正常值", () => {
    const plan = saleInstallmentPlan({ saleAmount: "1000", downPayment: "0", serviceFee: "100", periods: 3 })!;
    expect(saleInstallmentMismatch(plan, "333.34")).toBe(false);
    expect(saleInstallmentMismatch(plan, "300")).toBe(true); // 300×3 < 1000
    expect(saleInstallmentMismatch(plan, "600")).toBe(true); // 末期会为负
    expect(saleInstallmentMismatch(plan, "abc")).toBe(true);
    expect(saleInstallmentMismatch(null, "100")).toBe(false); // 期数非法时不重复拦截
  });

  it("每期服务费 = 服务费总额 / 期数，四舍五入到分", () => {
    expect(perPeriodServiceFee("100", 3)).toBe(33.33);
    expect(perPeriodServiceFee("300", 4)).toBe(75);
    expect(perPeriodServiceFee("100", 0)).toBeNull();
    expect(perPeriodServiceFee("abc", 3)).toBeNull();
  });

  it("分与元的换算对称", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(formatCents(1234)).toBe("12.34");
    expect(toCents(undefined)).toBe(0);
    expect(Number.isNaN(toCents("abc"))).toBe(true);
  });
});
