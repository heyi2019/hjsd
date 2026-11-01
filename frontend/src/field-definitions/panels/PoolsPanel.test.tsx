import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("shows pool configuration without the removed pool account feature", async () => {
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.queryByText("资金池账户")).not.toBeInTheDocument();
  });

  it("FE-239：资金池主数据失败时显示错误空态并禁用新增", async () => {
    vi.mocked(catalog.poolsApi.list).mockRejectedValueOnce(new Error("pools down"));
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("资金池数据不可用，请点击重新加载")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增资金池/ })).toBeDisabled();
  });
});
