// @vitest-environment jsdom
/** applyColumnConfig：按列表列配置过滤 + 排序的纯函数。
 *  口径：无配置原样返回；未知列视为可见并排末尾；隐藏列剔除。 */
import { describe, expect, it } from "vitest";
import { MOBILE_HIDE_CLASS, applyColumnConfig, columnKey, formatCustomValue, markMobileHiddenColumns, markMobileIdentityColumn, readCustomValue } from "@/shared/lib/listColumns";
import type { ListScopeConfig } from "@/shared/api/types/forms";

const config: ListScopeConfig = {
  code: "LEDGER",
  label: "订单台账",
  columns: [
    { key: "trade_date", label: "日期", locked: false, is_visible: true, sort_order: 0 },
    { key: "order_no", label: "订单号", locked: true, is_visible: true, sort_order: 10 },
  ],
};

const columns = [
  { dataIndex: "order_no" },
  { dataIndex: "trade_date" },
  { dataIndex: "unknown_new" },
];

describe("markMobileHiddenColumns", () => {
  // 显式标注列类型：字面量数组会被 TS 推断成「onCell 零参数、返回 { "data-x": string }」，
  // 与真实 ColumnType 不符，调用 onCell(record, index) / 读 cell.className 会误报 TS2554/TS2339。
  type MarkTestColumn = {
    key?: string;
    dataIndex?: string;
    className?: string;
    onCell?: (record: unknown, index?: number) => Record<string, unknown>;
  };
  const cols: MarkTestColumn[] = [
    { key: "customer_no" },
    { key: "phone", className: "keep", onCell: () => ({ "data-x": "1" }) },
    { key: "status" },
    { dataIndex: "created_at" },
  ];
  const hidden = ["phone", "created_at"];

  it("按 key 双写 th/td 标记，保留已有 className 与 onCell", () => {
    const result = markMobileHiddenColumns(cols, hidden);
    expect(result[0]).toEqual({ key: "customer_no" });
    expect(result[2]).toEqual({ key: "status" });
    expect(result[1].className).toBe(`keep ${MOBILE_HIDE_CLASS}`);
    const cell = result[1].onCell!({}, 0);
    expect(cell["data-x"]).toBe("1");
    expect(cell.className).toContain(MOBILE_HIDE_CLASS);
    expect(result[3].className).toContain(MOBILE_HIDE_CLASS);
  });

  it("列配置隐藏首列 + 调序后，被隐藏的仍是同一批 key（nth-child 会错位）", () => {
    const cfg: ListScopeConfig = {
      code: "CUSTOMER", label: "客户档案",
      columns: [
        { key: "status", label: "状态", locked: false, is_visible: true, sort_order: 0 },
        { key: "phone", label: "手机", locked: false, is_visible: true, sort_order: 10 },
        { key: "created_at", label: "建立时间", locked: false, is_visible: true, sort_order: 20 },
        { key: "customer_no", label: "客户编号", locked: false, is_visible: false, sort_order: 30 },
      ],
    };
    const arranged = applyColumnConfig(cols, cfg);
    const marked = markMobileHiddenColumns(arranged, hidden);
    expect(marked.map(columnKey)).toEqual(["status", "phone", "created_at"]);
    expect(marked.filter((c) => String((c as { className?: string }).className).includes(MOBILE_HIDE_CLASS)).map(columnKey))
      .toEqual(["phone", "created_at"]);
  });
});

describe("markMobileIdentityColumn", () => {
  it("优先固定订单号，并保留单元格原有属性", () => {
    const marked = markMobileIdentityColumn([
      { key: "date", className: "other", onCell: (_: unknown) => ({}) },
      { key: "order_no", className: "original", onCell: (_: unknown) => ({ className: "cell", title: "订单" }) },
    ], "order_no");
    expect(marked[0].className).toBe("other");
    expect(marked[1].className).toBe("original ui-col-mobile-identity");
    expect(marked[1].onCell({})).toEqual({ className: "cell ui-col-mobile-identity", title: "订单" });
  });

  it("首选列隐藏时固定首个移动端可见列", () => {
    const marked = markMobileIdentityColumn([
      { key: "order_no", className: `original ${MOBILE_HIDE_CLASS}` },
      { key: "date", className: "date" },
    ], "order_no");
    expect(marked[0].className).not.toContain("ui-col-mobile-identity");
    expect(marked[1].className).toContain("ui-col-mobile-identity");
  });
});

describe("applyColumnConfig", () => {
  it("自定义列优先显示订单保存的历史选项名称", () => {
    const configured: ListScopeConfig = {
      code: "LEDGER", label: "订单台账", columns: [{
        key: "extra:legacy_quality_tag", source_key: "legacy_quality_tag", label: "质量",
        locked: false, custom: true, is_visible: true, sort_order: 0,
        value_labels: { legacy_quality_tag_01: "新名称" },
      }],
    };
    type Column = { key?: string; render?: (value: unknown, row: unknown) => unknown };
    const column = applyColumnConfig<Column>([], configured)[0];
    expect(column.render?.(null, {
      extra_values: { legacy_quality_tag: "legacy_quality_tag_01" },
      option_label_snapshot: { legacy_quality_tag: "原名称" },
    })).toBe("原名称");
    expect(column.render?.(null, { extra_values: { legacy_quality_tag: "legacy_quality_tag_01" } })).toBe("新名称");
    expect(column.render?.(null, {
      extra_values: { legacy_quality_tag: ["legacy_quality_tag_01", "legacy_quality_tag_02"] },
      option_label_snapshot: { legacy_quality_tag: { legacy_quality_tag_01: "原甲", legacy_quality_tag_02: "原乙" } },
    })).toBe("原甲、原乙");
  });

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

  it("配置里的固定态覆盖到列定义上，列宽配置不再影响列定义", () => {
    const withSize: ListScopeConfig = {
      ...config,
      columns: config.columns.map((column) =>
        column.key === "order_no"
          ? { ...column, fixed: "left" as const }
          : column,
      ),
    };
    const result = applyColumnConfig(columns, withSize);
    const orderNo = result.find((column) => columnKey(column) === "order_no");
    expect(orderNo).toMatchObject({ fixed: "left" });
    // 未配置宽度的列不受影响（仍是原对象，不无谓重建）
    const tradeDate = result.find((column) => columnKey(column) === "trade_date");
    expect(tradeDate).toEqual({ dataIndex: "trade_date" });
  });

  it("fixed 为 null 时不覆盖，沿用列定义默认值", () => {
    const original = [{ dataIndex: "order_no", width: 220 }];
    const result = applyColumnConfig(original, {
      code: "LEDGER",
      label: "订单台账",
      columns: [
        {
          key: "order_no",
          label: "订单号",
          locked: true,
          is_visible: true,
          sort_order: 0,
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

  it("自定义列固定态覆盖同样生效，且不重复注入同名内置列", () => {
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
          fixed: "left" as const,
          custom: true,
          source_key: "vip_tag",
        },
      ],
    };
    const result = applyColumnConfig(columns, withCustom);
    expect(result.filter((column) => columnKey(column) === "extra:vip_tag")).toHaveLength(1);
    expect(result.find((column) => columnKey(column) === "extra:vip_tag")).toMatchObject({
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
