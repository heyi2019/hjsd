import { describe, expect, it } from "vitest";
import {
  fromCents,
  sumCents,
  sumMoney,
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

  it("大额输入和支出合计保留分位精度", () => {
    expect(sumMoney(["9999999999999999.98", "0.01"])).toBe("9999999999999999.99");
    expect(sumMoney(["90071992547409.91", "0.01"])).toBe("90071992547409.92");
  });

  it("sumCents：空值与非法值按 0 计（表单里空着等于没填）", () => {
    expect(sumMoney([null, undefined, "", "abc", "10"])).toBe("10.00");
    expect(sumMoney([])).toBe("0.00");
  });

});
