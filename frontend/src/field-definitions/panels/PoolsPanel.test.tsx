import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";

import * as catalog from "../../shared/api/catalog";
vi.mock("../../shared/api/catalog");

describe("PoolsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(catalog.poolsApi).list.mockResolvedValue([
      { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
    ]);
  });

  afterEach(cleanup);

  it("shows pool configuration without the removed pool account feature", async () => {
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.queryByText("资金池账户")).not.toBeInTheDocument();
  });

  it("编辑资金池保存失败时弹窗内显示错误且不关闭（L1801）", async () => {
    const ui = userEvent.setup();
    vi.mocked(catalog.poolsApi).update.mockRejectedValue(new Error("资金池保存失败"));
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });
    await screen.findByText("HJ_CUSTODY");

    await ui.click(screen.getByText("编辑"));
    expect(await screen.findByText("编辑资金池 · HJ_CUSTODY")).toBeInTheDocument();
    await ui.click(screen.getByText("保存"));

    // 编辑弹窗内即时显示错误，用户无需关闭弹窗去页面顶部找错误（限定弹窗体，避开页面级 ErrorBanner 的同文案）
    const modalBody = document.querySelector(".ant-modal-body") as HTMLElement;
    expect(await within(modalBody).findByText(/资金池保存失败/)).toBeInTheDocument();
    // 弹窗保持打开，保留已填表单供修正
    expect(screen.getByText("编辑资金池 · HJ_CUSTODY")).toBeInTheDocument();
    // 失败不触发列表重载，避免覆盖错误态
    expect(vi.mocked(catalog.poolsApi).list).toHaveBeenCalledTimes(1);
  });

  it("FE-239：资金池主数据失败时显示错误空态并禁用新增", async () => {
    vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce(new Error("pools down"));
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("资金池数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金池/ })).toBeDisabled();
  });
});
