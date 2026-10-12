import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "../../test/render";
import { PermissionButton, PermissionGate } from "./PermissionButton";

describe("PermissionButton：无权限默认隐藏", () => {
  it("admin 有权 → 渲染可点按钮", () => {
    renderApp(<PermissionButton permission="order.create">建单</PermissionButton>, { user: "admin" });
    const btn = screen.getByRole("button", { name: /建单/ });
    expect(btn).toBeEnabled();
  });

  it("viewer 无权 → 完全不渲染（DOM 里不存在）", () => {
    const { container } = renderApp(
      <PermissionButton permission="order.create">建单</PermissionButton>,
      { user: "viewer" },
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("showDisabled → 无权时渲染但禁用", () => {
    renderApp(
      <PermissionButton permission="order.create" showDisabled>
        建单
      </PermissionButton>,
      { user: "viewer" },
    );
    expect(screen.getByRole("button", { name: /建单/ })).toBeDisabled();
  });

  it("有权限时点击回调照常触发", async () => {
    const onClick = vi.fn();
    renderApp(
      <PermissionButton permission="order.create" onClick={onClick}>
        建单
      </PermissionButton>,
      { user: "admin" },
    );
    screen.getByRole("button", { name: /建单/ }).click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("operator 建单可见、审批不可见（权限矩阵落地）", () => {
    const { container } = renderApp(
      <>
        <PermissionButton permission="order.create">建单</PermissionButton>
        <PermissionButton permission="order.exception.approve">审批</PermissionButton>
      </>,
      { user: "operator" },
    );
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("建单");
    expect(labels).not.toContain("审批");
  });
});

describe("PermissionGate：区块级门控", () => {
  it("有权限渲染 children", () => {
    renderApp(
      <PermissionGate permission="finance.read">
        <span>资金明细</span>
      </PermissionGate>,
      { user: "viewer" },
    );
    expect(screen.getByText("资金明细")).toBeInTheDocument();
  });

  it("无权限渲染 fallback，未传则渲染空", () => {
    const { container } = renderApp(
      <PermissionGate permission="order.create">
        <span>建单区</span>
      </PermissionGate>,
      { user: "viewer" },
    );
    expect(container.textContent).toBe("");
  });

  it("无权限时可给 fallback 提示", () => {
    renderApp(
      <PermissionGate permission="order.create" fallback={<span>无权限</span>}>
        <span>建单区</span>
      </PermissionGate>,
      { user: "viewer" },
    );
    expect(screen.getByText("无权限")).toBeInTheDocument();
  });
});
