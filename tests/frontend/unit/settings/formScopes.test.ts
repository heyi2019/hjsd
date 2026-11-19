import { describe, expect, it } from "vitest";
import { buildGroupedScopeOptions } from "@/settings/formScopes";
import { normalizeOptionItems } from "@/settings/panels/OrderFormFieldsPanel.fragments";

const scopes = [
  { code: "SALE", label: "售出", group: "INVENTORY" },
  { code: "CONSIGN", label: "寄售", group: "INVENTORY" },
  { code: "INVREBATE", label: "返点", group: "INVENTORY" },
  { code: "INVREFUND", label: "取消", group: "INVENTORY" },
  { code: "INVEDIT", label: "编辑", group: "INVENTORY" },
  { code: "INVOID", label: "下架", group: "INVENTORY" },
  { code: "INVCANCEL", label: "取消", group: "INSTALLMENT" },
  { code: "REFUND", label: "资金收支", group: "ORDEROP" },
];

it("不为缺失的后端作用域制造本地兼容清单", () => {
  expect(buildGroupedScopeOptions([])).toEqual([]);
});

it("表单字段选项只接受后端规范对象", () => {
  expect(normalizeOptionItems([{ value: "A", label: "甲" }])).toEqual([{ value: "A", label: "甲" }]);
  expect(() => normalizeOptionItems(["A"] as never)).toThrow("选项必须使用 value/label 对象");
});

describe("表单作用域顺序", () => {
  it("按业务分组和组内动作顺序生成表单下拉选项", () => {
    const options = buildGroupedScopeOptions([
      { code: "FUNDFLOW", label: "录入流水", group: "FUND" },
      { code: "HS", label: "回收建单", group: "ORDER" },
          { code: "TH", label: "提号建单", group: "ORDER" },
      { code: "DG", label: "代挂建单", group: "ORDER" },
      { code: "ORDERCANC", label: "取消", group: "ORDEROP" },
      { code: "SALE", label: "库存售出", group: "INVENTORY" },
      { code: "CONSIGN", label: "寄售", group: "INVENTORY" },
    ]);

    expect(options.map((group) => group.label)).toEqual(["资金", "建单表单", "订单操作", "库存中心"]);
    expect(options[1].options.map((item) => item.value)).toEqual(["HS", "TH", "DG"]);
    expect(options[3].options.map((item) => item.value)).toEqual(["SALE", "CONSIGN"]);
  });

  it("库存中心按页面操作顺序排列表单", () => {
    const inventory = buildGroupedScopeOptions(scopes)
      .find((group) => group.label === "库存中心");

    expect(inventory?.options).toEqual([
      { value: "SALE", label: "售出" },
      { value: "CONSIGN", label: "寄售" },
      { value: "INVREBATE", label: "返点" },
      { value: "INVREFUND", label: "取消" },
      { value: "INVEDIT", label: "编辑" },
      { value: "INVOID", label: "下架" },
    ]);
  });

  it("取消表单归入实际业务页面", () => {
    const options = buildGroupedScopeOptions(scopes);
    expect(options.find((group) => group.label === "库存中心")?.options.map((item) => item.value)).toContain("INVREFUND");
    expect(options.find((group) => group.label === "分期与回款")?.options.map((item) => item.value)).toContain("INVCANCEL");
    expect(options.find((group) => group.label === "库存操作")).toBeUndefined();
  });

  it("平台下架和系统下架共用下架表单作用域", () => {
    const inventory = buildGroupedScopeOptions(scopes)
      .find((group) => group.label === "库存中心");
    expect(inventory?.options).toContainEqual({ value: "INVOID", label: "下架" });
    expect(inventory?.options.filter((item) => item.value === "INVOID")).toHaveLength(1);
  });

  it("退款作用域在表单配置中显示为资金收支", () => {
    const orderOperations = buildGroupedScopeOptions(scopes)
      .find((group) => group.label === "订单操作");
    expect(orderOperations?.options).toContainEqual({ value: "REFUND", label: "资金收支" });
  });
});
