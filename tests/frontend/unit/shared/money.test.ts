import { describe, expect, it } from "vitest";
import { moneyRules } from "@/shared/lib/validators";
import {
  compareMoney,
  sumMoney,
  toCents,
} from "@/shared/lib/money";

describe("shared/lib/money：前端金额一律按整数分运算", () => {
  it("金额格式与业务整数位数上限共用校验规则", async () => {
    const rule = moneyRules("金额", { maxIntegerDigits: 16 })[0];
    if (!("validator" in rule) || !rule.validator) throw new Error("缺少金额校验");
    const validate = (value: string) => rule.validator!(rule as never, value, () => undefined);
    await expect(validate("100.001")).rejects.toThrow("金额必须是数字，最多两位小数");
    await expect(validate("-1")).rejects.toThrow("金额不能为负数");
    await expect(validate("10000000000000000.00")).rejects.toThrow("金额整数部分最多16位");
    await expect(validate("0009999999999999999.99")).resolves.toBeUndefined();
    const signed = moneyRules("金额", { allowNegative: true })[0];
    if (!("validator" in signed) || !signed.validator) throw new Error("缺少金额校验");
    await expect(signed.validator(signed as never, "-1.00", () => undefined)).resolves.toBeUndefined();
  });
  it("金额比较保留任意精度并识别等值格式", () => {
    expect(compareMoney("001.2", "1.20")).toBe(0);
    expect(compareMoney(".5", "0.49")).toBe(1);
    expect(compareMoney("9999999999999999.98", "9999999999999999.99")).toBe(-1);
    expect(compareMoney("abc", "1")).toBeNull();
  });
  it("toCents 精确到分，不产生浮点尾差", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(1.005)).toBe(101); // 不做分换算时 1.005*100 = 100.49999999999999
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
    expect(Number.isNaN(toCents("abc"))).toBe(true);
  });

  it("sumMoney：0.1 + 0.2 必须等于 0.30", () => {
    expect(sumMoney([0.1, 0.2])).toBe("0.30");
  });

  it("大额输入和支出合计保留分位精度", () => {
    expect(sumMoney(["9999999999999999.98", "0.01"])).toBe("9999999999999999.99");
    expect(sumMoney(["90071992547409.91", "0.01"])).toBe("90071992547409.92");
  });

  it("sumMoney：空值与非法值按 0 计（表单里空着等于没填）", () => {
    expect(sumMoney([null, undefined, "", "abc", "10"])).toBe("10.00");
    expect(sumMoney([])).toBe("0.00");
  });

});
