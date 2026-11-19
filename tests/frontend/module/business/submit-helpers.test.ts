import { describe, expect, it } from "vitest";
import { splitFormExtra } from "@/business/create/submit-helpers";
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
