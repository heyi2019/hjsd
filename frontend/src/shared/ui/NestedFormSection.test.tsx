import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NestedFormField, NestedFormSection } from "./NestedFormSection";

describe("NestedFormSection：表中表", () => {
  it("输出标题、说明与通用字段结构", () => {
    const { container } = render(
      <NestedFormSection title="附加费用" description="没有发生就留空" className="nested-form-section--card">
        <NestedFormField label="中介费"><input aria-label="中介费金额" /></NestedFormField>
      </NestedFormSection>,
    );
    expect(screen.getByText("附加费用")).toBeInTheDocument();
    expect(screen.getByText("没有发生就留空")).toBeInTheDocument();
    expect(container.querySelector(".nested-form-section--card")).toBeTruthy();
    expect(container.querySelector(".nested-form-section__field-label")).toHaveTextContent("中介费");
  });
});
