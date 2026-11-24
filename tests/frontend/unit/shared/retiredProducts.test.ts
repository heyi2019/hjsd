import { describe, expect, it } from "vitest";
import {
  filterRetiredOrderTypeOptions,
  filterRetiredOrderTypes,
} from "@/shared/lib/retiredProducts";

describe("已下线产品过滤", () => {
  it("业务类型选项不再显示 DFQ，但保留现有业务类型", () => {
    expect(filterRetiredOrderTypeOptions([
      { value: "HS", label: "回收" },
      { value: "DFQ", label: "代分期" },
    ])).toEqual([{ value: "HS", label: "回收" }]);
  });

  it("业务类型主数据列表不再显示 DFQ", () => {
    expect(filterRetiredOrderTypes([
      { code: "HS", name: "回收" },
      { code: "DFQ", name: "代分期" },
    ])).toEqual([{ code: "HS", name: "回收" }]);
  });
});
