import { describe, expect, it } from "vitest";
import { buildOrderNote, resolveCustomerSource, splitFormExtra } from "@/business/create/submit-helpers";
import type { FieldConfigMap } from "@/business/ConfigurableField";

const config: FieldConfigMap = {
  optional_number: {
    id: 1,
    order_type_code: "HS",
    field_key: "optional_number",
    label: "可选数字",
    field_type: "NUMBER",
    options: null,
    required: false,
    is_active: true,
    sort_order: 0,
    locked: false,
    is_custom: true,
    note: null,
  },
};

describe("splitFormExtra", () => {
  it("不把清空的可选字段以 null 送入订单扩展字段", () => {
    const result = splitFormExtra({ form_extra: { optional_number: null } }, config);
    expect(result.orderFormExtra).toEqual({});
  });
});

it("代挂没有客户来源时仍保存订单备注", () => {
  expect(buildOrderNote({ dg_note: "委托备注" }, { isRecovery: false, isTh: false, isDg: true }, undefined)).toBe("委托备注");
});

it.each([
  [{ customer_source: "其他" }, false],
  [{ dg_customer_source: "其他", dg_customer_source_other: "  " }, true],
])("选择其他来源但未填写说明时保留其他选项", (values, isDg) => {
  expect(resolveCustomerSource(values, isDg)).toBe("其他");
});
