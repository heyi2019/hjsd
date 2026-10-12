import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("渲染标题与说明", () => {
    render(<PageHeader title="订单中心" description="订单与金额事件" />);
    expect(screen.getByRole("heading", { name: "订单中心" })).toBeInTheDocument();
    expect(screen.getByText("订单与金额事件")).toBeInTheDocument();
  });

  it("未传 description 时不渲染空段落", () => {
    const { container } = render(<PageHeader title="订单中心" />);
    expect(container.querySelector(".ui-page-header__desc")).toBeNull();
  });

  it("未传 actions 时不渲染动作区", () => {
    const { container } = render(<PageHeader title="订单中心" />);
    expect(container.querySelector(".ui-page-header__actions")).toBeNull();
  });

  it("actions 渲染到动作区", () => {
    render(<PageHeader title="订单中心" actions={<button type="button">新建</button>} />);
    const actions = document.querySelector(".ui-page-header__actions");
    expect(actions?.textContent).toBe("新建");
  });
});
