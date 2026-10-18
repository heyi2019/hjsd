import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLight } from "../../test/render";

const { poolsApi, poolAccountsApi } = vi.hoisted(() => ({
  poolsApi: {
    list: vi.fn(),
  },
  poolAccountsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../../shared/api/catalog", () => ({ poolsApi, poolAccountsApi }));

describe("PoolsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolsApi.list.mockResolvedValue([
      { id: 1, code: "HJ_CUSTODY", name: "托管池", pool_type: "OTHER", ownership: "OWNED", status: "ACTIVE" },
    ]);
    poolAccountsApi.list.mockResolvedValue([]);
  });

  it("shows and loads the pool account configuration", async () => {
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByText("资金池账户")).toBeInTheDocument();
    expect(poolAccountsApi.list).toHaveBeenCalled();
  });
});
