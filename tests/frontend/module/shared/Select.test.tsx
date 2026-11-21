import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

let receivedProps: Record<string, unknown> = {};

vi.mock("antd", () => ({
  Select: forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
    receivedProps = props;
    return <div ref={ref} />;
  }),
}));

import { Select } from "@/shared/ui/Select";
import { ToolbarSelect } from "@/shared/ui/ToolbarSelect";
import { ToolbarMultiSelect } from "@/shared/ui/ToolbarMultiSelect";
import { toolbarSelectionWidth } from "@/shared/ui/toolbarSelectionWidth";

describe("工具栏多选宽度", () => {
  it("随已选姓名增长，清空后恢复，并限制最大宽度", () => {
    expect(toolbarSelectionWidth([])).toBe(120);
    expect(toolbarSelectionWidth(["何一", "何二"])).toBeGreaterThan(toolbarSelectionWidth(["何一"]));
    expect(toolbarSelectionWidth(["何一", "何二", "何三"])).toBeGreaterThan(toolbarSelectionWidth(["何一", "何二"]));
    expect(toolbarSelectionWidth(["很长的员工姓名", "另一个很长的员工姓名", "第三个员工"])).toBe(240);
  });
});

describe("Select 公共弹层宽度", () => {
  it("工具栏单选按分组内最长选项确定宽度", () => {
    render(<ToolbarSelect options={[{ label: "分类", options: [{ value: "long", label: "工作室运营支出费用" }] }]} />);
    expect((receivedProps.style as { width: number }).width).toBeGreaterThan(150);
  });

  it("默认按选项内容展开，避免长选项被触发器宽度截断", () => {
    render(<Select options={[{ value: "owner", label: "经营中心负责人" }]} />);

    expect(receivedProps.popupMatchSelectWidth).toBe(false);
  });

  it("保留调用方显式指定的弹层宽度策略", () => {
    render(<Select popupMatchSelectWidth={true} />);

    expect(receivedProps.popupMatchSelectWidth).toBe(true);
  });
});


describe("公共下拉配置透传", () => {
  it("保留调用方弹层类名与公共弹层类名", () => {
    render(<Select popupClassName="legacy-popup" classNames={{ popup: { root: "custom-popup" } }} />);
    expect((receivedProps.classNames as { popup: { root: string } }).popup.root.split(" ")).toEqual(
      expect.arrayContaining(["ui-select-pop", "legacy-popup", "custom-popup"]),
    );
  });

  it("多选保留调用方类名及样式，同时继续根据选中项计算宽度", () => {
    render(<ToolbarMultiSelect selectedLabels={["何一"]} className="custom-multi" style={{ marginTop: 8 }} />);
    expect(receivedProps.className).toContain("ui-filter-multi");
    expect(receivedProps.className).toContain("custom-multi");
    expect(receivedProps.style).toEqual({ marginTop: 8, width: toolbarSelectionWidth(["何一"]) });
  });
});
