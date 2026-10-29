/** applyColumnConfig：按列表列配置过滤 + 排序的纯函数。
 *  口径：无配置原样返回；未知列视为可见并排末尾；隐藏列剔除。 */
import { describe, expect, it } from "vitest";
import { applyColumnConfig, columnKey, formatCustomValue, readCustomValue } from "./listColumns";
import type { ListScopeConfig } from "../api/catalog";

const config: ListScopeConfig = {
  code: "LEDGER",
  label: "业务台账",
  columns: [
    { key: "trade_date", label: "日期", locked: false, is_visible: true, sort_order: 0 },
    { key: "order_no", label: "订单号", locked: true, is_visible: true, sort_order: 10 },
    { key: "link_status", label: "关联", locked: false, is_visible: false, sort_order: 20 },
  ],
};

const columns = [
  { dataIndex: "order_no" },
  { dataIndex: "link_status" },
  { dataIndex: "trade_date" },
  { dataIndex: "unknown_new" },
];

describe("applyColumnConfig", () => {
  it("无配置时原样返回（列表不能因为没配置而少列）", () => {
    expect(applyColumnConfig(columns, undefined)).toEqual(columns);
  });

  it("按配置排序并剔除隐藏列", () => {
    const result = applyColumnConfig(columns, config);
    expect(result.map(columnKey)).toEqual(["trade_date", "order_no", "unknown_new"]);
  });

  it("未出现在配置里的新列保持可见并排在末尾", () => {
    const result = applyColumnConfig(columns, config);
    expect(result[result.length - 1]).toEqual({ dataIndex: "unknown_new" });
  });

  it("columnKey 支持 key / 字符串 dataIndex / 数组 dataIndex", () => {
    expect(columnKey({ key: "actions" })).toBe("actions");
    expect(columnKey({ dataIndex: "party" })).toBe("party");
    expect(columnKey({ dataIndex: ["a", "b"] })).toBe("a.b");
    expect(columnKey({})).toBe("");
  });

  it("配置里的列宽与固定态覆盖到列定义上", () => {
    const withSize: ListScopeConfig = {
      ...config,
      columns: config.columns.map((column) =>
        column.key === "order_no"
          ? { ...column, width: 160, fixed: "left" as const }
          : column,
      ),
    };
    const result = applyColumnConfig(columns, withSize);
    const orderNo = result.find((column) => columnKey(column) === "order_no");
    expect(orderNo).toMatchObject({ width: 160, fixed: "left" });
    // 未配置宽度的列不受影响（仍是原对象，不无谓重建）
    const tradeDate = result.find((column) => columnKey(column) === "trade_date");
    expect(tradeDate).toEqual({ dataIndex: "trade_date" });
  });

  it("width / fixed 为 null 时不覆盖，沿用列定义默认值", () => {
    const original = [{ dataIndex: "order_no", width: 220 }];
    const result = applyColumnConfig(original, {
      code: "LEDGER",
      label: "业务台账",
      columns: [
        {
          key: "order_no",
          label: "订单号",
          locked: true,
          is_visible: true,
          sort_order: 0,
          width: null,
          fixed: null,
        },
      ],
    });
    expect(result[0]).toEqual(original[0]);
  });

  it("自定义列自动注入：生成列定义、按 sort_order 排序、按 is_visible 隐藏", () => {
    const withCustom: ListScopeConfig = {
      ...config,
      columns: [
        ...config.columns,
        {
          key: "extra:vip_tag",
          label: "VIP 标签",
          locked: false,
          is_visible: true,
          sort_order: 5,
          custom: true,
          source_key: "vip_tag",
          value_labels: { A: "甲", B: "乙" },
        },
      ],
    };
    const result = applyColumnConfig(columns, withCustom);
    expect(result.map(columnKey)).toEqual([
      "trade_date",
      "extra:vip_tag",
      "order_no",
      "unknown_new",
    ]);
    const generated = result.find(
      (column) => columnKey(column) === "extra:vip_tag",
    ) as unknown as {
      title: string;
      render: (value: unknown, row: unknown) => string;
    };
    expect(generated.title).toBe("VIP 标签");
    expect(generated.render(null, { extra_values: { vip_tag: "A" } })).toBe("甲");
    expect(generated.render(null, { form_extra: { vip_tag: "B" } })).toBe("乙");
    expect(generated.render(null, {})).toBe("-");

    const hidden = applyColumnConfig(columns, {
      ...withCustom,
      columns: withCustom.columns.map((column) =>
        column.key === "extra:vip_tag" ? { ...column, is_visible: false } : column,
      ),
    });
    expect(hidden.map(columnKey)).not.toContain("extra:vip_tag");
  });

  it("自定义列宽/固定态覆盖同样生效，且不重复注入同名内置列", () => {
    const withCustom: ListScopeConfig = {
      ...config,
      columns: [
        ...config.columns,
        {
          key: "extra:vip_tag",
          label: "VIP 标签",
          locked: false,
          is_visible: true,
          sort_order: 30,
          width: 180,
          fixed: "left" as const,
          custom: true,
          source_key: "vip_tag",
        },
      ],
    };
    const result = applyColumnConfig(columns, withCustom);
    expect(result.filter((column) => columnKey(column) === "extra:vip_tag")).toHaveLength(1);
    expect(result.find((column) => columnKey(column) === "extra:vip_tag")).toMatchObject({
      width: 180,
      fixed: "left",
    });
  });

  it("readCustomValue：form_extra 优先，其次 extra_values，最后行对象自身键", () => {
    expect(readCustomValue({ form_extra: { a: 1 }, extra_values: { a: 2 } }, "a")).toBe(1);
    expect(readCustomValue({ extra_values: { a: 2 } }, "a")).toBe(2);
    expect(readCustomValue({ a: 3 }, "a")).toBe(3);
    expect(readCustomValue({ form_extra: null }, "a")).toBeUndefined();
    expect(readCustomValue(null, "a")).toBeUndefined();
  });

  it("formatCustomValue：选项翻译、多选顿号、布尔、空值与对象", () => {
    expect(formatCustomValue("A", { A: "甲" })).toBe("甲");
    expect(formatCustomValue(["A", "B"], { A: "甲", B: "乙" })).toBe("甲、乙");
    expect(formatCustomValue(true)).toBe("是");
    expect(formatCustomValue(false)).toBe("否");
    expect(formatCustomValue(null)).toBe("-");
    expect(formatCustomValue("")).toBe("-");
    expect(formatCustomValue({ x: 1 })).toBe('{"x":1}');
  });
});
