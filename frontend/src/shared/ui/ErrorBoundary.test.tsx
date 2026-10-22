import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ msg }: { msg: string }): never {
  throw new Error(msg);
}

describe("ErrorBoundary 页面级错误边界", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let shouldThrow = true;

  function ToggleBoom({ msg }: { msg: string }) {
    if (shouldThrow) throw new Error(msg);
    return <span>已恢复内容</span>;
  }

  beforeEach(() => {
    shouldThrow = true;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("正常渲染 children，不显示降级 UI", () => {
    render(
      <ErrorBoundary name="test">
        <span>健康内容</span>
      </ErrorBoundary>
    );
    expect(screen.getByText("健康内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("子组件抛错时显示降级 UI 并调用 componentDidCatch 记录日志 (DEV)", () => {
    vi.stubEnv("DEV", true);
    render(
      <ErrorBoundary name="leads">
        <Boom msg="boom-leads" />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("页面渲染出错")).toBeInTheDocument();
    expect(screen.getByText("boom-leads")).toBeInTheDocument();
    const hit = errSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("[ErrorBoundary:leads]")
    );
    expect(hit).toBeDefined();
    expect(hit![1]).toBeInstanceOf(Error);
  });

  it("生产模式不暴露错误明细，仅显示重试提示", () => {
    vi.stubEnv("DEV", false);
    render(
      <ErrorBoundary name="leads">
        <Boom msg="secret-detail" />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("secret-detail")).toBeNull();
    expect(
      screen.getByText(/页面出现意外错误，请点「重试」恢复/)
    ).toBeInTheDocument();
  });

  it("点击重试后恢复 children 渲染", () => {
    vi.stubEnv("DEV", true);
    render(
      <ErrorBoundary name="retry">
        <ToggleBoom msg="retry-boom" />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("已恢复内容")).toBeInTheDocument();
  });
});
