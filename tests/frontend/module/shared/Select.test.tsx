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

describe("Select 公共弹层宽度", () => {
  it("默认按选项内容展开，避免长选项被触发器宽度截断", () => {
    render(<Select options={[{ value: "owner", label: "经营中心负责人" }]} />);

    expect(receivedProps.popupMatchSelectWidth).toBe(false);
  });

  it("保留调用方显式指定的弹层宽度策略", () => {
    render(<Select popupMatchSelectWidth={true} />);

    expect(receivedProps.popupMatchSelectWidth).toBe(true);
  });
});
