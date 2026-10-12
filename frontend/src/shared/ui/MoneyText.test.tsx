import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MoneyText } from "./MoneyText";

describe("MoneyText：金额只展示，不做浮点运算", () => {
  it("字符串金额按千分位两位小数展示", () => {
    render(<MoneyText value="1234567.891" />);
    expect(screen.getByText("1,234,567.89")).toBeInTheDocument();
  });

  it("空值显示 -", () => {
    const { container } = render(<MoneyText value={null} />);
    expect(container.textContent).toBe("-");
  });

  it("tone=auto 时按正负自动上色（中国区惯例：正红负绿）", () => {
    const { container: pos } = render(<MoneyText value="100" tone="auto" />);
    expect(pos.querySelector(".ui-money--income")).toBeTruthy();
    const { container: neg } = render(<MoneyText value="-100" tone="auto" />);
    expect(neg.querySelector(".ui-money--expense")).toBeTruthy();
    const { container: zero } = render(<MoneyText value="0" tone="auto" />);
    expect(zero.querySelector(".ui-money--plain")).toBeTruthy();
  });

  it("显式 tone 覆盖 auto 推断", () => {
    const { container } = render(<MoneyText value="-100" tone="income" />);
    expect(container.querySelector(".ui-money--income")).toBeTruthy();
  });

  it("strong 追加强调类名", () => {
    const { container } = render(<MoneyText value="1" strong />);
    expect(container.querySelector(".ui-money--strong")).toBeTruthy();
  });

  it("0.1 与 0.2 分别展示为 0.10 / 0.20（证明前端没有做加法）", () => {
    const { container: a } = render(<MoneyText value="0.1" />);
    const { container: b } = render(<MoneyText value="0.2" />);
    expect(a.textContent).toBe("0.10");
    expect(b.textContent).toBe("0.20");
  });
});
