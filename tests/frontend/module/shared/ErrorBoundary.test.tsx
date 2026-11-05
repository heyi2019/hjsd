import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary, isModuleLoadError } from "@/shared/ui/ErrorBoundary";

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

describe("isModuleLoadError 模块加载失败判定", () => {
  it("识别动态 import 失败的多种浏览器措辞", () => {
    expect(
      isModuleLoadError(
        new Error("Failed to fetch dynamically imported module: http://192.168.124.12:5188/src/customers/CustomersPage.tsx?t=1793645133843")
      )
    ).toBe(true);
    expect(isModuleLoadError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isModuleLoadError(new Error("Importing a module script failed."))).toBe(true);
    expect(isModuleLoadError(new Error("Loading chunk 42 failed."))).toBe(true);
  });

  it("识别 ChunkLoadError（错误名而非 message 携带信息）", () => {
    const err = new Error("timeout of 30000ms exceeded");
    err.name = "ChunkLoadError";
    expect(isModuleLoadError(err)).toBe(true);
  });

  it("不把普通接口失败误判为模块失败", () => {
    expect(isModuleLoadError(new Error("Failed to fetch"))).toBe(false);
    expect(isModuleLoadError(new Error("Request failed with status code 500"))).toBe(false);
    expect(isModuleLoadError(new Error("加载订单失败"))).toBe(false);
  });

  it("空值返回 false", () => {
    expect(isModuleLoadError(null)).toBe(false);
    expect(isModuleLoadError(undefined)).toBe(false);
  });
});

describe("ErrorBoundary 模块加载失败不可原地重试", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("模块失败时按钮变「重新加载」，点击触发整页重载而非重置 state", () => {
    vi.stubEnv("DEV", true);
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: original.href, reload },
    });
    try {
      render(
        <ErrorBoundary name="customers">
          <Boom msg="Failed to fetch dynamically imported module: http://host/CustomersPage.tsx?t=1" />
        </ErrorBoundary>
      );
      // React.lazy 缓存的 rejected 是终态，界面必须给出「重新加载」而不是会空转的「重试」。
      fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, writable: true, value: original });
    }
  });

  it("生产模式对模块失败只给重载提示，不暴露 chunk 地址", () => {
    vi.stubEnv("DEV", false);
    render(
      <ErrorBoundary name="customers">
        <Boom msg="Failed to fetch dynamically imported module: http://host/secret-CustomersPage.tsx?t=1" />
      </ErrorBoundary>
    );
    expect(screen.getByText(/页面资源已更新或加载中断，请点「重新加载」/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-CustomersPage\.tsx/)).toBeNull();
  });
});
