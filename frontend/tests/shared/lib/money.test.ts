import { describe, expect, it } from "vitest";
import {
  amountByBasisPoints,
  basisPointsByAmount,
  fromBasisPoints,
  fromCents,
  sumCents,
  sumMoney,
  toBasisPoints,
  toCents,
} from "@/shared/lib/money";

describe("shared/lib/money：前端金额一律按整数分运算", () => {
  it("toCents 精确到分，不产生浮点尾差", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(1.005)).toBe(101); // 不做分换算时 1.005*100 = 100.49999999999999
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
    expect(Number.isNaN(toCents("abc"))).toBe(true);
  });

  it("fromCents 只负责展示格式", () => {
    expect(fromCents(1234)).toBe("12.34");
    expect(fromCents(0)).toBe("0.00");
    expect(fromCents(5)).toBe("0.05");
  });

  it("sumCents：0.1 + 0.2 必须等于 0.30", () => {
    expect(sumMoney([0.1, 0.2])).toBe("0.30");
    expect(sumCents(["8888.88", "0.01", "0.01"])).toBe(888890);
  });

  it("sumCents：空值与非法值按 0 计（表单里空着等于没填）", () => {
    expect(sumMoney([null, undefined, "", "abc", "10"])).toBe("10.00");
    expect(sumMoney([])).toBe("0.00");
  });

  it("比率互算：30% 分 1000.00 → 300.00，反向回 30.00%", () => {
    const profitCents = toCents("1000.00");
    const amount = amountByBasisPoints(profitCents, toBasisPoints(30));
    expect(fromCents(amount)).toBe("300.00");
    expect(fromBasisPoints(basisPointsByAmount(profitCents, amount))).toBe("30.00");
  });

  it("比率互算：三分之一这类除不尽的，两头各自四舍五入到分/0.01%", () => {
    const profitCents = toCents("100.00");
    expect(fromBasisPoints(basisPointsByAmount(profitCents, toCents("33.33")))).toBe("33.33");
    expect(fromCents(amountByBasisPoints(profitCents, toBasisPoints("33.33")))).toBe("33.33");
  });

  it("比率互算：总额为 0 时不算出 Infinity", () => {
    expect(Number.isNaN(basisPointsByAmount(0, 500))).toBe(true);
  });
});
