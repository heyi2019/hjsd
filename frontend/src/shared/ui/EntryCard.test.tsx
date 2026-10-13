import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EntryCard, EntryRow } from "./EntryCard";

describe("EntryCard：可点击入口卡", () => {
  it("点击触发 onClick", async () => {
    const onClick = vi.fn();
    render(<EntryCard title="订单总数" value="72" description="点击进入业务中心" onClick={onClick} />);
    expect(screen.getByText("订单总数")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /订单总数/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("键盘可达：Enter 与空格都能触发（div+role=button 不自发响应）", async () => {
    const onClick = vi.fn();
    render(<EntryCard title="新建业务" description="打开登记弹窗" onClick={onClick} />);
    const card = screen.getByRole("button", { name: /新建业务/ });
    card.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("动作卡无 value 时不渲染数值节点", () => {
    render(<EntryCard title="新建业务" onClick={() => undefined} />);
    expect(screen.queryByText("72")).toBeNull();
  });

  it("tone 落到样式类上（primary/warn/plain）", () => {
    const { container } = render(
      <EntryRow>
        <EntryCard title="a" tone="primary" onClick={() => undefined} />
        <EntryCard title="b" tone="warn" onClick={() => undefined} />
        <EntryCard title="c" onClick={() => undefined} />
      </EntryRow>,
    );
    expect(container.querySelector(".ui-entry-card--primary")).toBeTruthy();
    expect(container.querySelector(".ui-entry-card--warn")).toBeTruthy();
    expect(container.querySelector(".ui-entry-card--plain")).toBeTruthy();
    expect(container.querySelector(".ui-entry-row")).toBeTruthy();
  });
});
