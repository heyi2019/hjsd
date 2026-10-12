import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner：给可执行下一步，不只复述报错", () => {
  it("有错误码时同时给出文案与处置提示", () => {
    render(<ErrorBanner error={{ message: "缺少资金池路由", code: "POOL_ROUTE_MISSING" }} />);
    expect(screen.getByText("缺少资金池路由")).toBeInTheDocument();
    expect(screen.getByText(/设置 → 主数据/)).toBeInTheDocument();
  });

  it("裸字符串也能渲染（页面自定义提示）", () => {
    render(<ErrorBanner error="后端不可达" />);
    expect(screen.getByText("后端不可达")).toBeInTheDocument();
  });

  it("兼容旧传法：message + code 分开传", () => {
    render(<ErrorBanner message="校验失败" code="VALIDATION_ERROR" />);
    expect(screen.getByText("校验失败")).toBeInTheDocument();
    expect(screen.getByText(/必填项与格式/)).toBeInTheDocument();
  });

  it("无 message 时不渲染（不占版面）", () => {
    const { container } = render(<ErrorBanner error={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("未知错误码不显示 hint，但 message 仍在", () => {
    const { container } = render(<ErrorBanner error={{ message: "未知错误", code: "WHATEVER" }} />);
    expect(screen.getByText("未知错误")).toBeInTheDocument();
    expect(container.querySelector(".ant-alert-description")).toBeNull();
  });

  it("权限类错误给出「联系管理员」而非让用户重试", () => {
    render(<ErrorBanner error={{ message: "无权限", code: "PERMISSION_DENIED" }} />);
    expect(screen.getByText(/联系管理员/)).toBeInTheDocument();
  });
});
