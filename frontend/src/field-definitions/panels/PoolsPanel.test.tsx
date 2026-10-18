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
    vi.mocked(catalog.poolAccountsApi).list.mockResolvedValue([]);
  });

  it("shows and loads the pool account configuration", async () => {
    const { PoolsPanel } = await import("./PoolsPanel");
    renderLight(<PoolsPanel />, { user: "admin" });

    expect(await screen.findByText("HJ_CUSTODY")).toBeInTheDocument();
    expect(screen.getByText("资金池账户")).toBeInTheDocument();
    expect(vi.mocked(catalog.poolAccountsApi).list).toHaveBeenCalled();
  });
});
