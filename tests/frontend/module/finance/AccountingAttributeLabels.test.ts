import { describe, expect, it } from "vitest";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "@/shared/lib/labels";

describe("资金核算属性展示名称", () => {
  it("2026-11-18 口径改版后与后端枚举一一对应", () => {
    expect(ACCOUNTING_ATTRIBUTE_LABEL.SELF_DIRECT_COST).toBe("回收成本");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.SELF_REVENUE).toBe("回收收入");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.TH_DIRECT_COST).toBe("提号成本");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.TH_REVENUE).toBe("提号收入");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.DG_REVENUE).toBe("代挂收入");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.SERVICE_REVENUE).toBe("增值服务费收入");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.REBATE_INCOME).toBe("返点收入");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.OTHER_INCOME).toBe("其他收入");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.OTHER_EXPENSE).toBe("其他支出");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.OPERATING_EXPENSE).toBe("工作室运营支出");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.DEPOSIT).toBe("押金/保证金");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.EXTERNAL_FUNDING).toBe("外部资金");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.INTERNAL_TRANSFER).toBe("内部调拨");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.REVERSAL).toBe("冲销");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.REFUND).toBe("退款");
  });

  it("自营/附加/代挂成本旧概念已废弃", () => {
    // 注意：SELF_REVENUE 枚举值仍在（工作室收入共用），只是文案不再是「自营收入」。
    expect("ADDITIONAL_INCOME" in ACCOUNTING_ATTRIBUTE_LABEL).toBe(false);
    expect("ADDITIONAL_EXPENSE" in ACCOUNTING_ATTRIBUTE_LABEL).toBe(false);
    expect("DG_DIRECT_COST" in ACCOUNTING_ATTRIBUTE_LABEL).toBe(false);
  });
});
