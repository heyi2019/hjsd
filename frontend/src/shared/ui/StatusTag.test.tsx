import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLight } from "../../test/render";
import { StatusTag } from "./StatusTag";
import { statusColor } from "../lib/format";

describe("StatusTag：文案承载语义，颜色只是辅助", () => {
  it("已知状态渲染中文标签", () => {
    render(<StatusTag status="ACTIVE" />);
    expect(screen.getByText("进行中")).toBeInTheDocument();
  });

  it("通用 PENDING 只表示待结算，不再表示账号待入库", () => {
    render(<StatusTag status="PENDING" />);
    expect(screen.getByText("待结算")).toBeInTheDocument();
  });

  it("未知状态回落到原始状态码（不显示空白）", () => {
    render(<StatusTag status="SOME_NEW_STATUS" />);
    expect(screen.getByText("SOME_NEW_STATUS")).toBeInTheDocument();
  });

  it("传入 label 时以 label 为准", () => {
    render(<StatusTag status="ACTIVE" label="自定义" />);
    expect(screen.getByText("自定义")).toBeInTheDocument();
  });

  it("传入 color 时覆盖 statusColor", () => {
    const { container } = render(<StatusTag status="ACTIVE" color="red" />);
    expect(statusColor("ACTIVE")).toBe("green"); // 默认应仍是绿
    expect(container.querySelector(".ant-tag-red")).toBeTruthy();
  });

  it("10 个后端核心状态枚举必须都有中文文案（守卫规则⑦ 的运行时兜底）", () => {
    const coreStatuses = [
      "DRAFT",
      "ACTIVE",
      "COMPLETED",
      "CANCELLED",
      "PENDING",
      "OVERDUE",
      "SETTLED",
      "DEFAULTED",
      "DELIVERED",
      "IN_STOCK",
    ];
    const { container, unmount } = render(<div />);
    unmount();
    for (const status of coreStatuses) {
      const { container: box } = render(<StatusTag status={status} />);
      const text = box.textContent ?? "";
      // 回落实现是「原样显示状态码」，因此文案等于状态码即代表漏配
      expect(text).not.toBe(status);
      expect(text.length).toBeGreaterThan(0);
    }
    expect(container).toBeTruthy();
  });

  it("导入批次状态（MIG-01）有中文文案", () => {
    render(<StatusTag status="UNMAPPED" />);
    expect(screen.getByText("未映射")).toBeInTheDocument();
  });

  it("金额相关状态不影响渲染（组件不参与金额计算）", () => {
    renderLight(<StatusTag status="PARTIALLY_SETTLED" />);
    expect(screen.getByText("部分结算")).toBeInTheDocument();
  });
});
