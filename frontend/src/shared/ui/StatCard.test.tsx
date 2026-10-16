import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatCard, StatRow } from "./StatCard";

describe("StatRow：金额与计数不能混", () => {
  it("kind=money → 千分位两位小数", () => {
    render(<StatRow items={[{ label: "成交额", amount: "1234.5", kind: "money" }]} />);
    expect(screen.getByText("1,234.50")).toBeInTheDocument();
  });

  it("kind=count → 原样显示，不加小数（订单数不能被当成金额）", () => {
    render(<StatRow items={[{ label: "订单数", amount: 14565, kind: "count" }]} />);
    expect(screen.getByText("14565")).toBeInTheDocument();
  });

  it("number 型 amount 未显式 kind 时按 count 推断（守卫规则① 要求显式声明）", () => {
    render(<StatRow items={[{ label: "订单数", amount: 14565 }]} />);
    expect(screen.getByText("14565")).toBeInTheDocument();
  });

  it("字符串 amount 未显式 kind 时按 money 推断", () => {
    render(<StatRow items={[{ label: "成交额", amount: "14565" }]} />);
    expect(screen.getByText("14,565.00")).toBeInTheDocument();
  });

  it("缺失金额显示 -，不显示 0", () => {
    render(
      <StatRow
        items={[
          { label: "成交额", amount: null },
          { label: "订单数", amount: undefined },
        ]}
      />,
    );
    expect(screen.getAllByText("-")).toHaveLength(2);
  });

  it("tone=warn 不改变金额格式，只换卡片语气", () => {
    const { container } = render(
      <StatRow items={[{ label: "风险提示", amount: "88.8", tone: "warn" }]} />,
    );
    expect(screen.getByText("88.80")).toBeInTheDocument();
    expect(container.querySelector(".ui-stat--warn")).toBeTruthy();
  });

  it("tone=auto → 金额不参与上色决策（StatRow 回落到 plain）", () => {
    const { container } = render(
      <StatRow items={[{ label: "净额", amount: "-100", tone: "auto" }]} />,
    );
    expect(container.querySelector(".ui-stat--plain")).toBeTruthy();
  });

  it("hint 可选，未传不渲染空节点", () => {
    const { container } = render(<StatRow items={[{ label: "成交额", amount: "1" }]} />);
    expect(container.querySelector(".ui-stat__hint")).toBeNull();
  });
});

describe("StatCard：基础容器", () => {
  it("label / value / hint 三段齐全", () => {
    render(<StatCard label="本金" value="¥100" hint="含税" />);
    expect(screen.getByText("本金")).toBeInTheDocument();
    expect(screen.getByText("¥100")).toBeInTheDocument();
    expect(screen.getByText("含税")).toBeInTheDocument();
  });

  it("默认 tone=plain", () => {
    const { container } = render(<StatCard label="本金" value="1" />);
    expect(container.querySelector(".ui-stat--plain")).toBeTruthy();
  });
});
