import { describe, expect, it } from "vitest";
import { ACCOUNTING_ATTRIBUTE_LABEL } from "@/shared/lib/labels";

describe("资金核算属性展示名称", () => {
  it("成本属性不再展示直接成本口径", () => {
    expect(ACCOUNTING_ATTRIBUTE_LABEL.SELF_DIRECT_COST).toBe("回收成本");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.TH_DIRECT_COST).toBe("提号成本");
    expect(ACCOUNTING_ATTRIBUTE_LABEL.DG_DIRECT_COST).toBe("代挂成本");
  });
});
