/** 经营规则配置 schema 的纯函数契约。
 *
 * 锁死三件事：
 * 1. 表单值 ↔ 后端 config 的双向转换（声明式字段与嵌套分润表）；
 * 2. 空值的丢弃规则（与既有 seed 数据同形状，不产生 "" / null 噪音）；
 * 3. 版本历史的人话展示（嵌套对象不能渲染成 [object Object]）。
 */
import { describe, expect, it } from "vitest";
import {
  configToFields,
  describeConfig,
  fieldsToConfig,
  policyConfigFields,
  policyHasConfig,
  rateTableTotal,
} from "@/policy/policyConfigSchema";

describe("policyConfigSchema", () => {
  it("五类可配置规则都给出字段", () => {
    for (const code of ["COMMISSION", "INSTALLMENT", "WRITE_DOWN", "REFUND", "DG_MIXED"]) {
      expect(policyHasConfig(code)).toBe(true);
    }
    // 未知编码仍视为不可配置（防御未来新增但未定义字段的规则）
    expect(policyConfigFields("NOT_EXISTS")).toEqual([]);
    expect(policyHasConfig("NOT_EXISTS")).toBe(false);
    // 关键字段必须在：分润按动作拆分的比例表 / 服务费率 / 跌价比例 / 期数
    expect(policyConfigFields("COMMISSION").map((f) => f.key)).toEqual(["split"]);
    expect(policyConfigFields("INSTALLMENT").map((f) => f.key)).toContain("service_fee_rate");
    expect(policyConfigFields("WRITE_DOWN")[0].kind).toBe("rate-table");
    expect(policyConfigFields("WRITE_DOWN")[0].rows).toHaveLength(3);
  });

  it("分润按动作拆分：买入/卖出/运营/公司四行，默认 30/30/0/40 且合计必须 100", () => {
    const [split] = policyConfigFields("COMMISSION");
    expect(split.kind).toBe("rate-table");
    expect(split.rows?.map((r) => r.key)).toEqual(["BUY", "SELL", "OPERATION", "COMPANY"]);
    expect(split.sumTo).toBe(100);
    // 未配置规则时表单直接落业务默认口径，不需要手填到 100%
    expect(configToFields("COMMISSION", {})).toEqual({
      split: { BUY: "30", SELL: "30", OPERATION: "0", COMPANY: "40" },
    });
  });

  it("合计校验：rateTableTotal 只对已填数字求和", () => {
    expect(rateTableTotal({ BUY: "30", SELL: "30", OPERATION: "", COMPANY: "40" }, [
      { key: "BUY" },
      { key: "SELL" },
      { key: "OPERATION" },
      { key: "COMPANY" },
    ])).toBe(100);
    expect(rateTableTotal(undefined, [{ key: "BUY" }])).toBe(0);
  });

  it("表单 → config：只保留非空值", () => {
    // 数字控件可能回传 number，统一 String 化以匹配后端字符串口径
    expect(fieldsToConfig("INSTALLMENT", { periods: 3, cycle: "monthly" })).toEqual({
      periods: "3",
      cycle: "monthly",
    });
  });

  it("版本历史展示：按 schema 翻译成中文，未知编码回落原始 key=value", () => {
    expect(describeConfig({ split: { BUY: "30", SELL: "30", OPERATION: "0", COMPANY: "40" } }, "COMMISSION")).toBe(
      "买入动作=30 · 卖出动作=30 · 运营动作=0 · 公司=40",
    );
    expect(describeConfig({ cycle: "monthly" }, "INSTALLMENT")).toBe("还款节奏=按月");
    // 无 code / 未知键：回落 key=value
    expect(describeConfig({ rates: { BUY: "5", SELL: "3" } })).toBe("rates.BUY=5 · rates.SELL=3");
    expect(describeConfig({ rate: "5" })).toBe("rate=5");
    expect(describeConfig({})).toBe("（无参数）");
    expect(describeConfig(null)).toBe("（无参数）");
  });

  it("返点规则不再包含费率配置", () => {
    expect(policyConfigFields("REBATE")).toEqual([]);
    expect(policyHasConfig("REBATE")).toBe(false);
    const others = ["COMMISSION", "INSTALLMENT", "WRITE_DOWN", "REFUND", "DG_MIXED"];
    for (const code of others) {
      expect(policyConfigFields(code).filter((f) => f.effective === "calc")).toEqual([]);
    }
  });
});
